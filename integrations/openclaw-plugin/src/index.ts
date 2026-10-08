import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { IncomingMessage, ServerResponse } from "node:http";
import { withDsaRouteAccess } from "./access.js";
import { configSchema, registrationState } from "./config.js";
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
function unavailable(req: IncomingMessage, res: ServerResponse): boolean {
  const body = Buffer.from(JSON.stringify({ error: "dsa_workbench_not_configured", message: "Complete valid admin paths and ingress identity are required; all DSA business access is disabled." }));
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
entry.register = (api) => {
    const state = registrationState(api.pluginConfig);
    if (!state.ready) api.logger.warn("[dsa-workbench] Business routes unavailable: complete valid admin configuration is required.");
    registerDeclaredTools(api);
    api.session.controls.registerControlUiDescriptor({
      surface: "tab", id: "dsa-workbench", label: "股票研究",
      description: "原 DSA 报告概览与完整私人手动工作台", icon: "chart-line",
      group: "agent", order: 40, path: `${ROUTE_ROOT}/`, requiredScopes: ["operator.read"],
    });
    api.registerHttpRoute({
      path: `${ROUTE_ROOT}/`, match: "prefix", auth: "plugin",
      // The inactive branch never constructs ReportData or the upstream proxy.
      handler: withDsaRouteAccess(state.ready ? createDsaHttpHandler(state.config) : unavailable, { ...state.access, logger: api.logger }),
    });
};

// Official artifacts copy no arbitrary app/ files. Retain the complete original
// build as an embedded, inspectable resource catalog, not a native UI initializer.
// HTTP serving still uses the explicit admin staticDir and unchanged file guards.
export { BUNDLED_APP_ASSETS, BUNDLED_APP_ASSET_HASHES } from "./resources.generated.js";
export default entry;
