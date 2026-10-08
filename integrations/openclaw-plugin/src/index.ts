import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { withDsaRouteAccess } from "./access.js";
import { configSchema, parseConfig } from "./config.js";
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
entry.register = (api) => {
    const config = parseConfig(api.pluginConfig);
    registerDeclaredTools(api);
    api.session.controls.registerControlUiDescriptor({
      surface: "tab", id: "dsa-workbench", label: "股票研究",
      description: "原 DSA 报告概览与完整私人手动工作台", icon: "chart-line",
      group: "agent", order: 40, path: `${ROUTE_ROOT}/`, requiredScopes: ["operator.read"],
    });
    api.registerHttpRoute({
      path: `${ROUTE_ROOT}/`, match: "prefix", auth: "plugin",
      handler: withDsaRouteAccess(createDsaHttpHandler(config), { ...config, logger: api.logger }),
    });
};

// Official artifacts copy no arbitrary app/ files. Retain the complete original
// build as an embedded, inspectable resource catalog, not a native UI initializer.
// HTTP serving still uses the explicit admin staticDir and unchanged file guards.
export { BUNDLED_APP_ASSETS, BUNDLED_APP_ASSET_HASHES } from "./resources.generated.js";
export default entry;
