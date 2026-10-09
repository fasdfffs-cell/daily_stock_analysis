import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { IncomingMessage, ServerResponse } from "node:http";
import { withDsaRouteAccess } from "./access.js";
import { configSchema, parseConfig, resolveRegistrationConfig } from "./config.js";
import { createDsaHttpHandler } from "./http.js";
import { ROUTE_ROOT } from "./policy.js";

// The public factory supplies generated metadata without inventing agent tools.
// Its returned entry exposes the normal public register hook for composition.
const entry = defineToolPlugin({
  id: "dsa-workbench",
  name: "DSA Workbench",
  description: "Saved stock reports and a private same-origin original DSA workbench.",
  configSchema,
  tools: () => [],
});
const registerDeclaredTools = entry.register;
const UNCONFIGURED_BODY = Buffer.from(JSON.stringify({ error: "dsa_workbench_not_configured", message: "DSA Workbench is not configured; all business access is disabled." }));
function unavailable(req: IncomingMessage, res: ServerResponse): boolean {
  const body = UNCONFIGURED_BODY;
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
entry.register = (api) => {
    const input = api.pluginConfig ?? {};
    let config: ReturnType<typeof parseConfig> | undefined;
    if (entry.configSchema?.safeParse?.(input).success && (Object.hasOwn(input, "dbPath") || Object.hasOwn(input, "staticDir"))) {
      try { config = resolveRegistrationConfig(input, Object.hasOwn(input, "accessPolicySource") ? api.config : undefined); } catch { /* Invalid setup stays inert, never local business. */ }
    }
    if (!config) api.logger.warn("[dsa-workbench] Business routes unavailable: complete valid admin configuration is required.");
    registerDeclaredTools(api);
    api.session.controls.registerControlUiDescriptor({
      surface: "tab", id: "dsa-workbench", label: "股票研究",
      description: "原 DSA 报告与私人研究工作台 · 原生定时", icon: "chart-line",
      group: "agent", order: 40, path: `${ROUTE_ROOT}/`, requiredScopes: ["operator.read"],
    });
    api.registerHttpRoute({
      path: `${ROUTE_ROOT}/`, match: "prefix", auth: "plugin",
      // No identity/network/DB/proxy initialization in the fixed inactive branch.
      // Complete config preserves the original guard, including its local-trust policy.
      handler: config ? withDsaRouteAccess(createDsaHttpHandler(config), { ...config, logger: api.logger }) : unavailable,
    });
};

// Official artifacts copy no arbitrary app/ files. Retain the complete original
// build as an embedded, inspectable resource catalog, not a native UI initializer.
// HTTP serving still uses the explicit admin staticDir and unchanged file guards.
export { BUNDLED_APP_ASSETS, BUNDLED_APP_ASSET_HASHES } from "./resources.generated.js";
export default entry;
