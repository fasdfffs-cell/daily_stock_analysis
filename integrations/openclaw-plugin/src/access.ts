// Adapted from the owner-authored workspace/todo-plugin/src/access.ts (2026-10-08).
// Vendored here, not imported from an external workspace. See SECURITY.md.
import { execFile } from "node:child_process";
import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { TextDecoder } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAX_ACCESS_JWT_BYTES = 16 * 1024;
export const MAX_JWKS_BYTES = 256 * 1024;
export const MAX_JWKS_KEYS = 32;
export const DEFAULT_JWKS_CACHE_MS = 5 * 60 * 1000;
export const MIN_JWKS_CACHE_MS = 60 * 1000;
export const MAX_JWKS_CACHE_MS = 10 * 60 * 1000;
export const JWKS_FETCH_TIMEOUT_MS = 5_000;
export const JWKS_REFRESH_COOLDOWN_MS = 5_000;

const MAX_HOST_BYTES = 253;
const MAX_ISSUER_BYTES = 512;
const MAX_AUDIENCE_BYTES = 2_048;
const MAX_EMAIL_BYTES = 320;
const MAX_KID_BYTES = 256;
const MAX_JWT_PART_BYTES = 12 * 1024;

export type JwksFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type DsaAccessRejectReason =
  | "non-loopback"
  | "incomplete-config"
  | "host-mismatch"
  | "forwarded-host-mismatch"
  | "proto-mismatch"
  | "mixed-ingress"
  | "missing-assertion"
  | "jwt-format"
  | "jwt-alg"
  | "jwt-kid"
  | "jwt-signature"
  | "jwt-jwks"
  | "jwt-issuer"
  | "jwt-audience"
  | "jwt-time"
  | "jwt-email"
  | "email-mismatch"
  | "tailscale-config"
  | "tailscale-client-mismatch"
  | "tailscale-login-mismatch"
  | "tailscale-whois-mismatch";

interface AccessDiagnosticLogger {
  warn(message: string): void;
}

interface AccessDenied {
  ok: false;
  reason: DsaAccessRejectReason;
}

type AccessDecision = { ok: true } | AccessDenied;
type JwtVerificationResult = { ok: true; claims: Record<string, unknown> } | AccessDenied;
type KeyLookupResult = { ok: true; key: KeyObject } | AccessDenied;

const ACCESS_ALLOWED: AccessDecision = { ok: true };

function denied(reason: DsaAccessRejectReason): AccessDenied {
  return { ok: false, reason };
}

export interface DsaRouteAccessConfig {
  tailscaleBin: string;
  tailscaleLogin: string;
  cloudflareAccessHost?: string;
  cloudflareAccessIssuer?: string;
  cloudflareAccessAudience?: string;
  cloudflareAccessEmail?: string;
  whois?: (ip: string) => Promise<string | null>;
  jwksFetch?: JwksFetch;
  now?: () => number;
  logger?: AccessDiagnosticLogger;
}

interface CachedJwks {
  expiresAt: number;
  keys: Map<string, KeyObject>;
}

interface JwtParts {
  signingInput: Buffer;
  signature: Buffer;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

function headerValues(req: IncomingMessage, name: string): string[] {
  const lowerName = name.toLowerCase();
  const raw: string[] = [];
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === lowerName) raw.push(req.rawHeaders[index + 1] ?? "");
  }
  if (raw.length) return raw;
  const cooked = req.headers[lowerName];
  if (Array.isArray(cooked)) return cooked;
  return typeof cooked === "string" ? [cooked] : [];
}

function singleHeader(req: IncomingMessage, name: string, maxBytes: number): string | null {
  const values = headerValues(req, name);
  if (values.length !== 1) return null;
  const value = values[0];
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : null;
}

function hasHeader(req: IncomingMessage, name: string): boolean {
  return headerValues(req, name).length > 0;
}

function hasHeaderPrefix(req: IncomingMessage, prefix: string): boolean {
  const lowerPrefix = prefix.toLowerCase();
  return Object.keys(req.headers).some((name) => name.toLowerCase().startsWith(lowerPrefix));
}

function isLoopback(value: string | undefined): boolean {
  if (!value) return false;
  const ip = value.startsWith("::ffff:") ? value.slice(7) : value;
  if (ip === "::1") return true;
  if (isIP(ip) !== 4) return false;
  return ip.split(".")[0] === "127";
}

async function systemWhoisLogin(executable: string, ip: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executable, ["whois", "--json", ip], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout) as { UserProfile?: { LoginName?: unknown } };
    const login = parsed.UserProfile?.LoginName;
    return typeof login === "string" && login.trim() ? login.trim() : null;
  } catch {
    return null;
  }
}

function hasProxyHeaders(req: IncomingMessage, cloudflareHost: string | undefined): boolean {
  const hasCloudflareAuthority = Boolean(cloudflareHost && headerValues(req, "host").some((value) => {
    const host = value.toLowerCase();
    return host === cloudflareHost.toLowerCase() || host.startsWith(`${cloudflareHost.toLowerCase()}:`);
  }));
  return hasHeaderPrefix(req, "x-forwarded-")
    || hasHeaderPrefix(req, "tailscale-")
    || hasHeaderPrefix(req, "cf-")
    || hasHeader(req, "forwarded")
    || hasCloudflareAuthority;
}

function decodeBase64Url(value: string, maxBytes: number): Buffer | null {
  if (!value || value.length > maxBytes * 2 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length > maxBytes || decoded.toString("base64url") !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJwt(value: string): JwtParts | null {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_ACCESS_JWT_BYTES) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const encodedHeader = parts[0];
  const encodedClaims = parts[1];
  const encodedSignature = parts[2];
  const headerBytes = decodeBase64Url(encodedHeader, MAX_JWT_PART_BYTES);
  const claimBytes = decodeBase64Url(encodedClaims, MAX_JWT_PART_BYTES);
  const signature = decodeBase64Url(encodedSignature, 1024);
  if (!headerBytes || !claimBytes || !signature) return null;
  const header = parseJsonObject(headerBytes);
  const claims = parseJsonObject(claimBytes);
  if (!header || !claims) return null;
  return {
    signingInput: Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
    signature,
    header,
    claims,
  };
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasAudience(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected && Buffer.byteLength(value, "utf8") <= MAX_AUDIENCE_BYTES;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false;
  return value.every((entry) => boundedString(entry, MAX_AUDIENCE_BYTES)) && value.includes(expected);
}

function cacheTtl(headers: Headers): number {
  const cacheControl = headers.get("cache-control") ?? "";
  for (const directive of cacheControl.split(",")) {
    const match = /^\s*max-age\s*=\s*(\d+)\s*$/iu.exec(directive);
    if (!match) continue;
    const milliseconds = Number(match[1]) * 1000;
    if (!Number.isSafeInteger(milliseconds)) break;
    return Math.min(MAX_JWKS_CACHE_MS, Math.max(MIN_JWKS_CACHE_MS, milliseconds));
  }
  return DEFAULT_JWKS_CACHE_MS;
}

async function boundedResponseBody(response: Response): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_JWKS_BYTES)) {
    throw new Error("invalid JWKS response size");
  }
  if (!response.body) throw new Error("missing JWKS response body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_JWKS_BYTES) throw new Error("JWKS response is too large");
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks);
}

function parseJwks(bytes: Buffer): Map<string, KeyObject> {
  const parsed = parseJsonObject(bytes);
  if (!parsed || !Array.isArray(parsed.keys) || parsed.keys.length === 0 || parsed.keys.length > MAX_JWKS_KEYS) {
    throw new Error("invalid JWKS");
  }
  const keys = new Map<string, KeyObject>();
  const seenKids = new Set<string>();
  for (const rawKey of parsed.keys) {
    if (!rawKey || typeof rawKey !== "object" || Array.isArray(rawKey)) throw new Error("invalid JWK");
    const jwk = rawKey as Record<string, unknown>;
    if (!boundedString(jwk.kid, MAX_KID_BYTES) || seenKids.has(jwk.kid)) throw new Error("invalid JWK kid");
    seenKids.add(jwk.kid);
    if (jwk.kty !== "RSA" || (jwk.alg !== undefined && jwk.alg !== "RS256")) continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify"))) continue;
    if (!boundedString(jwk.n, MAX_JWT_PART_BYTES) || !boundedString(jwk.e, 32)) continue;
    try {
      const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
      if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
      keys.set(jwk.kid, key);
    } catch {
      // Ignore unusable entries; a response with no usable RS256 keys fails below.
    }
  }
  if (keys.size === 0) throw new Error("JWKS has no usable RS256 keys");
  return keys;
}

class CloudflareAccessVerifier {
  private cache: CachedJwks | null = null;
  private refreshPromise: Promise<CachedJwks> | null = null;
  private lastRefreshAttempt = Number.NEGATIVE_INFINITY;

  constructor(private readonly config: DsaRouteAccessConfig) {}

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  private async fetchJwks(): Promise<CachedJwks> {
    const issuer = this.config.cloudflareAccessIssuer;
    if (!issuer || Buffer.byteLength(issuer, "utf8") > MAX_ISSUER_BYTES) throw new Error("missing issuer");
    const endpoint = `${issuer}/cdn-cgi/access/certs`;
    const fetcher = this.config.jwksFetch ?? globalThis.fetch;
    const response = await fetcher(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("JWKS fetch failed");
    const keys = parseJwks(await boundedResponseBody(response));
    return { keys, expiresAt: this.now() + cacheTtl(response.headers) };
  }

  private async refresh(): Promise<CachedJwks> {
    if (this.refreshPromise) return this.refreshPromise;
    this.lastRefreshAttempt = this.now();
    this.refreshPromise = this.fetchJwks();
    try {
      const next = await this.refreshPromise;
      this.cache = next;
      return next;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async keyFor(kid: string): Promise<KeyLookupResult> {
    const now = this.now();
    if (this.cache && now < this.cache.expiresAt) {
      const cached = this.cache.keys.get(kid);
      if (cached) return { ok: true, key: cached };
      if (now - this.lastRefreshAttempt < JWKS_REFRESH_COOLDOWN_MS) return denied("jwt-kid");
    }
    try {
      const refreshed = await this.refresh();
      const key = refreshed.keys.get(kid);
      return key ? { ok: true, key } : denied("jwt-kid");
    } catch {
      const fallback = this.cache;
      const key = fallback && now < fallback.expiresAt ? fallback.keys.get(kid) : undefined;
      return key ? { ok: true, key } : denied("jwt-jwks");
    }
  }

  async verify(jwt: string): Promise<JwtVerificationResult> {
    const parsed = parseJwt(jwt);
    if (!parsed) return denied("jwt-format");
    if (parsed.header.alg !== "RS256" || parsed.header.crit !== undefined) return denied("jwt-alg");
    if (!boundedString(parsed.header.kid, MAX_KID_BYTES)) return denied("jwt-kid");
    const keyResult = await this.keyFor(parsed.header.kid);
    if (!keyResult.ok) return keyResult;
    if (!verifySignature("RSA-SHA256", parsed.signingInput, keyResult.key, parsed.signature)) {
      return denied("jwt-signature");
    }

    const issuer = this.config.cloudflareAccessIssuer;
    const audience = this.config.cloudflareAccessAudience;
    const expectedEmail = this.config.cloudflareAccessEmail;
    if (!issuer || !audience) return denied("incomplete-config");
    if (parsed.claims.iss !== issuer) return denied("jwt-issuer");
    if (!hasAudience(parsed.claims.aud, audience)) return denied("jwt-audience");
    if (!boundedString(parsed.claims.email, MAX_EMAIL_BYTES)) return denied("jwt-email");
    if (expectedEmail && parsed.claims.email !== expectedEmail) return denied("jwt-email");
    if (!validNumericDate(parsed.claims.exp)) return denied("jwt-time");
    const nowSeconds = Math.floor(this.now() / 1000);
    if (nowSeconds >= parsed.claims.exp) return denied("jwt-time");
    if (parsed.claims.nbf !== undefined && (!validNumericDate(parsed.claims.nbf) || nowSeconds < parsed.claims.nbf)) {
      return denied("jwt-time");
    }
    return { ok: true, claims: parsed.claims };
  }
}

const cloudflareVerifiers = new WeakMap<DsaRouteAccessConfig, CloudflareAccessVerifier>();

function verifierFor(config: DsaRouteAccessConfig): CloudflareAccessVerifier {
  let verifier = cloudflareVerifiers.get(config);
  if (!verifier) {
    verifier = new CloudflareAccessVerifier(config);
    cloudflareVerifiers.set(config, verifier);
  }
  return verifier;
}

function completeCloudflareConfig(config: DsaRouteAccessConfig): boolean {
  return Boolean(
    config.cloudflareAccessHost
    && config.cloudflareAccessIssuer
    && config.cloudflareAccessAudience,
  );
}

function logRejected(config: DsaRouteAccessConfig, reason: DsaAccessRejectReason): void {
  try {
    config.logger?.warn(`[access-reject] plugin=dsa-workbench reason=${reason}`);
  } catch {
    // Diagnostics must never change fail-closed authorization behavior.
  }
}

async function authorizeCloudflare(req: IncomingMessage, config: DsaRouteAccessConfig): Promise<AccessDecision> {
  if (!completeCloudflareConfig(config)) return denied("incomplete-config");
  if (hasHeaderPrefix(req, "tailscale-") || hasHeader(req, "forwarded")) return denied("mixed-ingress");
  const host = singleHeader(req, "host", MAX_HOST_BYTES);
  if (!host || host.toLowerCase() !== config.cloudflareAccessHost) return denied("host-mismatch");
  const forwardedHostValues = headerValues(req, "x-forwarded-host");
  if (forwardedHostValues.length > 0) {
    const forwardedHost = singleHeader(req, "x-forwarded-host", MAX_HOST_BYTES);
    if (!forwardedHost || forwardedHost.toLowerCase() !== config.cloudflareAccessHost) {
      return denied("forwarded-host-mismatch");
    }
  }
  const proto = singleHeader(req, "x-forwarded-proto", 16);
  if (!proto || proto.toLowerCase() !== "https") return denied("proto-mismatch");

  const assertion = singleHeader(req, "cf-access-jwt-assertion", MAX_ACCESS_JWT_BYTES);
  if (!assertion) return denied("missing-assertion");
  const verification = await verifierFor(config).verify(assertion);
  if (!verification.ok) return verification;

  const emailValues = headerValues(req, "cf-access-authenticated-user-email");
  if (emailValues.length > 0) {
    const claimedEmail = singleHeader(req, "cf-access-authenticated-user-email", MAX_EMAIL_BYTES);
    if (!claimedEmail || claimedEmail !== verification.claims.email) return denied("email-mismatch");
  }
  return ACCESS_ALLOWED;
}

async function authorizeTailscale(req: IncomingMessage, config: DsaRouteAccessConfig): Promise<AccessDecision> {
  if (!config.tailscaleLogin) return denied("tailscale-config");
  if (hasHeaderPrefix(req, "cf-") || hasHeader(req, "forwarded") || hasHeader(req, "tailscale-funnel-request")) {
    return denied("mixed-ingress");
  }
  const proto = singleHeader(req, "x-forwarded-proto", 16);
  if (!proto || proto.toLowerCase() !== "https") return denied("proto-mismatch");
  const forwardedHost = singleHeader(req, "x-forwarded-host", MAX_HOST_BYTES)?.trim().toLowerCase();
  if (!forwardedHost || forwardedHost.includes(",") || !forwardedHost.split(":", 1)[0]?.endsWith(".ts.net")) {
    return denied("forwarded-host-mismatch");
  }
  const clientIp = singleHeader(req, "x-forwarded-for", 128)?.trim();
  if (!clientIp || clientIp.includes(",") || isIP(clientIp) === 0 || isLoopback(clientIp)) {
    return denied("tailscale-client-mismatch");
  }
  const claimedLogin = singleHeader(req, "tailscale-user-login", MAX_EMAIL_BYTES)?.trim();
  if (!claimedLogin || claimedLogin !== config.tailscaleLogin) return denied("tailscale-login-mismatch");
  const whois = config.whois ?? ((ip: string) => systemWhoisLogin(config.tailscaleBin, ip));
  const verifiedLogin = await whois(clientIp);
  return verifiedLogin === claimedLogin ? ACCESS_ALLOWED : denied("tailscale-whois-mismatch");
}

async function accessDecision(req: IncomingMessage, config: DsaRouteAccessConfig): Promise<AccessDecision> {
  if (!isLoopback(req.socket.remoteAddress)) return denied("non-loopback");
  if (!hasProxyHeaders(req, config.cloudflareAccessHost)) {
    const host = singleHeader(req, "host", MAX_HOST_BYTES);
    if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/iu.test(host)) return denied("host-mismatch");
    return ACCESS_ALLOWED;
  }
  if (hasHeaderPrefix(req, "cf-") || singleHeader(req, "host", MAX_HOST_BYTES)?.toLowerCase() === config.cloudflareAccessHost) {
    return authorizeCloudflare(req, config);
  }
  return authorizeTailscale(req, config);
}

export async function authorizeDsaRead(
  req: IncomingMessage,
  config: DsaRouteAccessConfig,
): Promise<boolean> {
  const decision = await accessDecision(req, config);
  if (!decision.ok) logRejected(config, decision.reason);
  return decision.ok;
}

export function withDsaRouteAccess(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void,
  config: DsaRouteAccessConfig,
) {
  // Construct/cache the verifier before the first request so this wrapper shares
  // one bounded JWKS cache across GET, HEAD, and POST authorization checks.
  verifierFor(config);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!await authorizeDsaRead(req, config)) {
      const body = Buffer.from(JSON.stringify({ error: "Dsa 页面访问身份验证失败" }));
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", String(body.length));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(body);
      return true;
    }
    await handler(req, res);
    return true;
  };
}
