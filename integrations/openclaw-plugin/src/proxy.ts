import { Agent, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline, Transform } from "node:stream";
import type { DsaConfig } from "./config.js";
import { APP_BASE, BACKEND_ORIGIN, MAX_RESPONSE_BYTES, RequestError, ingressOrigin, single, sessionCookie, validateOrigin, writeBody, type ApiRoute } from "./policy.js";

export const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function appSecurity(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", APP_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
}
export function rewrittenCookies(raw: string[] | undefined): string[] {
  const selected = (raw || []).filter(v => v.split("=", 1)[0] === "dsa_session");
  if (selected.length > 1) throw new RequestError(502, "Ambiguous upstream session cookie");
  return selected.map(cookie => {
    if (cookie.length > 4096 || /[\r\n\x00]/.test(cookie)) throw new RequestError(502, "Invalid upstream cookie");
    const [nameValue, ...attrs] = cookie.split(";").map(s => s.trim());
    if (!/^dsa_session=[A-Za-z0-9_.:\-]*$/.test(nameValue)) throw new RequestError(502, "Invalid upstream session cookie");
    const retained = attrs.filter(v => /^Max-Age=-?\d{1,10}$/i.test(v) || /^Expires=[A-Za-z0-9 ,:\-]{10,64}$/i.test(v));
    return [nameValue, `Path=${APP_BASE}/`, "HttpOnly", "Secure", "SameSite=Lax", ...retained].join("; ");
  });
}
export function rewrittenLocation(location: string, publicOrigin: string, upstreamOrigin = BACKEND_ORIGIN): string {
  if (location.length > 2048 || /[\\\x00-\x20\x7f]/.test(location) || location.startsWith("//")) throw new RequestError(502, "Unsafe upstream redirect");
  const url = new URL(location, upstreamOrigin);
  if (![publicOrigin, upstreamOrigin].includes(url.origin) || url.username || url.password || url.hash || /%|\/\.|\/\//.test(url.pathname)) throw new RequestError(502, "External upstream redirect is forbidden");
  if (!["/", "/login", "/index.html"].includes(url.pathname)) throw new RequestError(502, "Unknown upstream redirect path");
  for (const [key, value] of url.searchParams) {
    if (key !== "redirect" || url.searchParams.getAll(key).length !== 1 || value.length > 1024 || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x1f]/.test(value)) throw new RequestError(502, "Unsafe redirect query");
    // Preserve app confinement for the React login resolver.
    if (!value.startsWith(`${APP_BASE}/`)) url.searchParams.set(key, `${APP_BASE}${value}`);
  }
  return `${APP_BASE}${url.pathname}${url.search}`;
}
/** Internal dependency injection is numeric-port-only and never an install config or HTTP parameter. */
export interface ProxyTestOptions { upstreamPort?: number; }
export function createDsaProxy(config: DsaConfig, test: ProxyTestOptions = {}) {
  const port = test.upstreamPort ?? Number(new URL(BACKEND_ORIGIN).port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid loopback port");
  const upstreamOrigin = `http://127.0.0.1:${port}`;
  // Fixed internal application hop only. Do not send localhost through a host's
  // outbound credential proxy or mutate globalAgent/proxy environment. Neither
  // environment credentials nor arbitrary request authorities enter this agent.
  const internalAgent = new Agent({ keepAlive: false, maxSockets: 8, maxTotalSockets: 8 });
  const hostHeaders = (req: IncomingMessage, cookie: string | undefined) => ({
    host: `127.0.0.1:${port}`, accept: "application/json",
    ...(cookie ? { cookie } : {}),
  });
  async function statusCheck(req: IncomingMessage, cookie: string | undefined): Promise<{ body: Buffer; loggedIn: boolean }> {
    return new Promise((resolve, reject) => {
      let ended = false;
      const upstream = httpRequest({ agent: internalAgent, hostname: "127.0.0.1", port, path: "/api/v1/auth/status", method: "GET", headers: hostHeaders(req, cookie), timeout: 5000, maxHeaderSize: 16 * 1024 }, response => {
        const chunks: Buffer[] = []; let size = 0;
        const fail = () => { response.destroy(); reject(new RequestError(503, "DSA authentication status unavailable")); };
        if (response.statusCode !== 200 || response.headers["content-encoding"] || !/^application\/json(?:;|$)/i.test(response.headers["content-type"] || "")) return fail();
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 8192) fail(); else chunks.push(chunk); });
        response.on("error", () => reject(new RequestError(503, "DSA authentication status unavailable")));
        response.on("end", () => {
          ended = true;
          try {
            const body = Buffer.concat(chunks); const status = JSON.parse(body.toString("utf8"));
            // Never let Access/local trust substitute for mandatory DSA login.
            if (status.authEnabled !== true || typeof status.loggedIn !== "boolean") throw new Error("Mandatory DSA authentication required");
            resolve({ body, loggedIn: status.loggedIn });
          } catch { reject(new RequestError(503, "DSA must run with mandatory authentication")); }
        });
        response.on("close", () => { if (!ended) reject(new RequestError(503, "Incomplete DSA authentication status")); });
      });
      const close = () => { if (!resAlive(req)) upstream.destroy(); };
      req.on("aborted", close);
      upstream.on("timeout", () => upstream.destroy(new Error("Auth status deadline")));
      upstream.on("error", () => reject(new RequestError(503, "DSA authentication status unavailable")));
      upstream.on("close", () => req.off("aborted", close));
      upstream.end();
    });
  }
  return async function proxy(req: IncomingMessage, res: ServerResponse, route: ApiRoute, search: string): Promise<void> {
    const origin = validateOrigin(req, config, route.write);
    const cookie = sessionCookie(req);
    const method = req.method!;
    if (!route.write) {
      const length = single(req, "content-length", 16);
      if (length !== undefined && length !== "0") throw new RequestError(400, "Read requests cannot contain a body");
    }
    const body = route.write ? await writeBody(req, route.kind) : undefined;
    const status = await statusCheck(req, cookie);
    if (res.destroyed || req.aborted) return;
    appSecurity(res);
    if (route.kind === "status") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", status.body.length);
      res.end(method === "HEAD" ? undefined : status.body); return;
    }
    if (route.kind !== "login" && !status.loggedIn) throw new RequestError(401, "DSA login is required");
    const accept = single(req, "accept", 1024) || (route.kind === "sse" ? "text/event-stream" : "application/json");
    const headers = { ...hostHeaders(req, cookie), accept,
      ...(origin ? { origin } : {}),
      ...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}),
    };
    await new Promise<void>((resolve, reject) => {
      let completed = false;
      let targetResponse: IncomingMessage | undefined;
      const cleanup = () => { res.off("close", disconnect); req.off("aborted", disconnect); };
      const finish = () => { if (!completed) { completed = true; cleanup(); resolve(); } };
      const fail = (error: unknown) => {
        upstream.destroy(); targetResponse?.destroy();
        if (res.headersSent) { res.destroy(); finish(); }
        else if (!completed) { completed = true; cleanup(); reject(error instanceof RequestError ? error : new RequestError(502, "DSA loopback request failed")); }
      };
      const disconnect = () => { if (!res.writableEnded) { upstream.destroy(); targetResponse?.destroy(); } finish(); };
      const upstream = httpRequest({ agent: internalAgent, hostname: "127.0.0.1", port, path: route.path + search, method, headers,
        maxHeaderSize: 16 * 1024, timeout: route.kind === "analyze" ? 650000 : route.kind === "sse" ? 45000 : 15000,
      }, response => {
        targetResponse = response;
        try {
          if (response.headers["content-encoding"]) throw new RequestError(502, "Encoded upstream responses are not accepted");
          const code = response.statusCode || 502;
          const location = response.headers.location;
          if (code >= 300 && code < 400 && !location) throw new RequestError(502, "Missing upstream redirect target");
          const mapped = location ? rewrittenLocation(location, ingressOrigin(req, config), upstreamOrigin) : undefined;
          const cookies = rewrittenCookies(response.headers["set-cookie"]);
          const contentType = response.headers["content-type"] || "application/json; charset=utf-8";
          if (contentType.length > 200 || !/^(?:application\/json|text\/event-stream|text\/plain)(?:;|$)/i.test(contentType)) throw new RequestError(502, "Unexpected upstream content type");
          const length = response.headers["content-length"];
          if (length && (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new RequestError(502, "Upstream response exceeds limit");
          res.statusCode = code;
          res.setHeader("Content-Type", contentType);
          if (mapped) res.setHeader("Location", mapped);
          if (cookies.length) res.setHeader("Set-Cookie", cookies);
          // No Access-CORS, Gateway auth, other cookies or arbitrary response headers escape this boundary.
          if (route.kind === "sse") {
            if (code === 200 && !/^text\/event-stream(?:;|$)/i.test(contentType)) throw new RequestError(502, "Invalid SSE stream");
            res.setHeader("X-Accel-Buffering", "no");
            response.setTimeout(45000, () => fail(new RequestError(504, "SSE heartbeat deadline")));
            res.flushHeaders();
          } else if (length) res.setHeader("Content-Length", length);
          let size = 0;
          const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (route.kind !== "sse" && size > MAX_RESPONSE_BYTES) callback(new RequestError(502, "Upstream response exceeds limit"));
            else callback(null, chunk);
          } });
          pipeline(response, bounded, res, error => { if (error) fail(error); else finish(); });
        } catch (error) { fail(error); }
      });
      res.on("close", disconnect); req.on("aborted", disconnect);
      upstream.on("timeout", () => fail(new RequestError(504, "DSA request deadline")));
      upstream.on("error", () => { if (!completed) fail(new RequestError(502, "DSA loopback request failed")); });
      upstream.end(body);
    });
  };
}
function resAlive(req: IncomingMessage): boolean { return !req.aborted && !req.destroyed; }
