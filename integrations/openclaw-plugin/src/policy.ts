import type { IncomingMessage } from "node:http";
import type { DsaConfig } from "./config.js";

export const ROUTE_ROOT = "/plugins/dsa-workbench";
export const APP_BASE = `${ROUTE_ROOT}/app`;
// Deliberately not configurable from an HTTP request or a URL-bearing config field.
export const BACKEND_ORIGIN = "http://127.0.0.1:8010";
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function values(req: IncomingMessage, name: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) found.push(req.rawHeaders[i + 1] || "");
  }
  return found;
}
export function single(req: IncomingMessage, name: string, limit: number, required = false): string | undefined {
  const all = values(req, name);
  if (all.length > 1 || (required && all.length !== 1) || all.some(v => Buffer.byteLength(v) > limit || /[\x00-\x1f\x7f]/.test(v))) throw new RequestError(400, "Invalid or duplicate request header");
  return all[0];
}
export function canonicalUrl(raw: string): URL {
  const path = raw.split("?", 1)[0];
  if (raw.length > 4096 || !raw.startsWith("/") || raw.startsWith("//") || /[\\\x00-\x20\x7f#]/.test(raw)
    || /%/.test(path) || path.includes("//") || path.split("/").some(p => p === "." || p === ".." || p.startsWith("."))) throw new RequestError(400, "Non-canonical path");
  if (/%(?![0-9a-f]{2})/i.test(raw)) throw new RequestError(400, "Invalid query encoding");
  return new URL(raw, "http://plugin.invalid");
}
export function boundHeaders(req: IncomingMessage): void {
  const bytes = req.rawHeaders.reduce((n, v) => n + Buffer.byteLength(v), 0);
  if (bytes > 32 * 1024 || req.rawHeaders.length > 160) throw new RequestError(431, "Request headers too large");
  if (values(req, "transfer-encoding").length || values(req, "content-encoding").length || values(req, "upgrade").length) throw new RequestError(400, "Encoded, chunked or upgraded requests are not supported");
}
export function ingressOrigin(req: IncomingMessage, config: DsaConfig): string {
  const host = single(req, "host", 253, true)!;
  const proto = single(req, "x-forwarded-proto", 16);
  if (host === config.cloudflareAccessHost && config.cloudflareAccessHost) return `https://${host}`;
  if (values(req, "tailscale-user-login").length) return `https://${single(req, "x-forwarded-host", 253, true)}`;
  return `${proto || ((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted ? "https" : "http")}://${host}`;
}
export function validateOrigin(req: IncomingMessage, config: DsaConfig, write: boolean): string | undefined {
  const origin = single(req, "origin", 512);
  const expected = ingressOrigin(req, config);
  if ((write && !origin) || (origin !== undefined && origin !== expected)) throw new RequestError(403, "Exact same-origin request required");
  const site = single(req, "sec-fetch-site", 32);
  if (site && !["same-origin", "none"].includes(site)) throw new RequestError(403, "Cross-site requests are forbidden");
  return origin;
}
export function sessionCookie(req: IncomingMessage): string | undefined {
  const cookie = single(req, "cookie", 8192);
  if (!cookie) return undefined;
  const sessions = cookie.split(";").map(s => s.trim()).filter(s => s.split("=", 1)[0] === "dsa_session");
  if (sessions.length > 1) throw new RequestError(400, "Ambiguous DSA session cookie");
  if (!sessions.length) return undefined;
  if (!/^dsa_session=[A-Za-z0-9_.:\-]{1,2048}$/.test(sessions[0])) throw new RequestError(400, "Invalid DSA session cookie");
  return sessions[0];
}
export type ApiKind = "status" | "login" | "password" | "logout" | "read" | "sse" | "analyze" | "watchlist" | "cancel";
export interface ApiRoute { path: string; kind: ApiKind; write: boolean; }
export function apiRoute(url: URL, method: string): ApiRoute {
  const path = url.pathname.slice(APP_BASE.length);
  const reads: [RegExp, ApiKind, string[]][] = [
    [/^\/api\/v1\/auth\/status$/, "status", []],
    [/^\/api\/v1\/workbench\/status$/, "read", []],
    [/^\/api\/v1\/stocks\/watchlist$/, "read", []],
    [/^\/api\/v1\/history$/, "read", ["page", "limit", "stock_code", "report_type", "start_date", "end_date"]],
    [/^\/api\/v1\/history\/stocks$/, "read", ["limit", "start_date", "end_date"]],
    [/^\/api\/v1\/history\/[1-9][0-9]{0,9}(?:\/(?:markdown|news|diagnostics|flow))?$/, "read", ["limit"]],
    [/^\/api\/v1\/analysis\/tasks$/, "read", ["status", "limit"]],
    [/^\/api\/v1\/analysis\/tasks\/stream$/, "sse", []],
    [/^\/api\/v1\/analysis\/(?:status\/[A-Za-z0-9_-]{1,100}|tasks\/[A-Za-z0-9_-]{1,100}\/flow)$/, "read", []],
  ];
  const writes: [RegExp, ApiKind][] = [
    [/^\/api\/v1\/auth\/login$/, "login"], [/^\/api\/v1\/auth\/change-password$/, "password"], [/^\/api\/v1\/auth\/logout$/, "logout"],
    [/^\/api\/v1\/analysis\/analyze$/, "analyze"], [/^\/api\/v1\/stocks\/watchlist\/(?:add|remove)$/, "watchlist"],
    [/^\/api\/v1\/workbench\/cancel\/[A-Za-z0-9_-]{1,100}$/, "cancel"],
  ];
  const read = reads.find(([re]) => re.test(path)); const write = writes.find(([re]) => re.test(path));
  if (!read && !write) throw new RequestError(403, "Operation disabled in the manual workbench");
  if (read && !["GET", "HEAD"].includes(method) || write && method !== "POST") throw new RequestError(405, "Method not allowed");
  const allowed = new Set(read?.[2] || []);
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1 || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw new RequestError(400, "Unsupported or duplicate query parameter");
    if (["limit", "page"].includes(key) && (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > (key === "limit" ? 100 : 10000))) throw new RequestError(400, "Query size is out of bounds");
    if (["start_date", "end_date"].includes(key) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RequestError(400, "Invalid date filter");
  }
  return { path, kind: (read?.[1] || write?.[1])!, write: Boolean(write) };
}
function checkedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "JSON object required");
  return value as Record<string, unknown>;
}
export async function writeBody(req: IncomingMessage, kind: ApiKind): Promise<Buffer> {
  const rawLength = single(req, "content-length", 16);
  if (!rawLength || !/^(?:0|[1-9][0-9]*)$/.test(rawLength)) throw new RequestError(411, "One explicit Content-Length is required");
  const length = Number(rawLength);
  if (length > MAX_BODY_BYTES) throw new RequestError(413, "Request body exceeds 64 KiB");
  const type = single(req, "content-type", 100);
  if (length && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(type || "")) throw new RequestError(415, "Only bounded UTF-8 JSON is accepted; file uploads are disabled");
  const chunks: Buffer[] = []; let received = 0;
  for await (const data of req) {
    const chunk = Buffer.from(data); received += chunk.length;
    if (received > length || received > MAX_BODY_BYTES) throw new RequestError(413, "Invalid request size");
    chunks.push(chunk);
  }
  if (received !== length) throw new RequestError(400, "Content-Length mismatch");
  let body: Record<string, unknown> = {};
  if (length) {
    try { body = checkedObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
    catch { throw new RequestError(400, "Invalid JSON body"); }
  }
  const allowed: Partial<Record<ApiKind, string[]>> = {
    login: ["password", "passwordConfirm"], password: ["currentPassword", "newPassword", "newPasswordConfirm"], logout: [], cancel: [], watchlist: ["stock_code"],
    analyze: ["stock_code", "stock_codes", "report_type", "force_refresh", "async_mode", "analysis_phase", "stock_name", "original_query", "selection_source", "skills", "report_language", "notify"],
  };
  if (Object.keys(body).some(key => !allowed[kind]?.includes(key))) throw new RequestError(400, "Unknown body field");
  for (const value of Object.values(body)) {
    if (typeof value === "string" && value.length > 4096 || value && typeof value === "object" && (!Array.isArray(value) || value.length > 8 || value.some(v => typeof v !== "string" || v.length > 200))) throw new RequestError(400, "Body field too large or unsupported");
  }
  if (["login", "password"].includes(kind) && Object.values(body).some(v => typeof v !== "string" || v.length > 1024)) throw new RequestError(400, "Invalid authentication field");
  if (kind === "watchlist" || kind === "analyze") {
    const codes = Array.isArray(body.stock_codes) && body.stock_codes.length ? body.stock_codes : [body.stock_code];
    if (codes.length !== 1 || typeof codes[0] !== "string" || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(codes[0]) || body.stock_code && body.stock_code !== codes[0]) throw new RequestError(400, "One explicit US symbol is required");
  }
  if (kind === "analyze") {
    if (body.notify !== undefined && body.notify !== false) throw new RequestError(403, "Notifications are forbidden");
    for (const key of ["async_mode", "force_refresh"]) if (body[key] !== undefined && typeof body[key] !== "boolean") throw new RequestError(400, "Invalid boolean field");
    if (body.report_type !== undefined && !["simple", "detailed"].includes(String(body.report_type))) throw new RequestError(400, "Unsupported report type");
    body.notify = false;
  }
  // Canonicalize once. The backend consumes exactly the same fields we validated.
  return Buffer.from(JSON.stringify(body));
}
