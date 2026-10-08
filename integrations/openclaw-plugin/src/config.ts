import { isAbsolute, resolve } from "node:path";

export interface DsaConfig {
  dbPath: string;
  staticDir: string;
  tailscaleBin: string;
  tailscaleLogin: string;
  cloudflareAccessHost: string;
  cloudflareAccessIssuer: string;
  cloudflareAccessAudience: string;
  cloudflareAccessEmail: string;
}
const DEFAULTS: DsaConfig = {
  dbPath: "",
  staticDir: "",
  tailscaleBin: "/usr/bin/tailscale", tailscaleLogin: "",
  cloudflareAccessHost: "", cloudflareAccessIssuer: "",
  cloudflareAccessAudience: "", cloudflareAccessEmail: "",
};
// Ordinary JSON Schema is accepted by the public SDK. Keep authoring metadata
// and runtime parsing on the same strict field set; no location-relative defaults.
export const configSchema = {
  type: "object", additionalProperties: false, required: ["dbPath", "staticDir"],
  properties: {
    dbPath: { type: "string", minLength: 1 },
    staticDir: { type: "string", minLength: 1 },
    tailscaleBin: { type: "string", default: "/usr/bin/tailscale" },
    tailscaleLogin: { type: "string", default: "", maxLength: 320 },
    cloudflareAccessHost: { type: "string", default: "", maxLength: 253 },
    cloudflareAccessIssuer: { type: "string", default: "", maxLength: 512 },
    cloudflareAccessAudience: { type: "string", default: "", maxLength: 2048 },
    cloudflareAccessEmail: { type: "string", default: "", maxLength: 320 },
  },
};
export function parseConfig(input: Record<string, unknown> = {}): DsaConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Plugin config must be an object");
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULTS, key))) throw new Error("Unknown plugin configuration key");
  const result = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof DsaConfig)[]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string") throw new Error("Plugin configuration values must be strings");
      result[key] = input[key].trim();
    }
  }
  for (const key of ["dbPath", "staticDir", "tailscaleBin"] as const) {
    if (!isAbsolute(result[key]) || result[key].includes("\0")) throw new Error(`${key} must be an explicit absolute admin path`);
    result[key] = resolve(result[key]);
  }
  const access = [result.cloudflareAccessHost, result.cloudflareAccessIssuer, result.cloudflareAccessAudience];
  if (access.some(Boolean) && !access.every(Boolean)) throw new Error("Access host, issuer and audience must be configured together; email is optional");
  if (!access.some(Boolean) && result.cloudflareAccessEmail) throw new Error("Optional email requires the complete Access configuration");
  if (access.every(Boolean)) {
    if (result.cloudflareAccessHost.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(result.cloudflareAccessHost)) throw new Error("Access host must be a lowercase hostname without a port or path");
    if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(result.cloudflareAccessIssuer)) throw new Error("Access issuer must be one fixed team HTTPS origin on cloudflareaccess.com");
    if (Buffer.byteLength(result.cloudflareAccessAudience) > 2048 || Buffer.byteLength(result.cloudflareAccessEmail) > 320 || /[\s\x00-\x1f\x7f]/.test(result.cloudflareAccessEmail) || result.cloudflareAccessEmail && !result.cloudflareAccessEmail.includes("@")) throw new Error("Access identity configuration is invalid or oversized");
  }
  if (Buffer.byteLength(result.tailscaleLogin) > 320 || /[\r\n\0]/.test(result.tailscaleLogin)) throw new Error("Invalid Tailscale identity");
  return result;
}
