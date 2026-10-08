import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { withDsaRouteAccess } from "./access.js";
import { parseConfig } from "./config.js";
import { createDsaHttpHandler } from "./http.js";
import { ROUTE_ROOT } from "./policy.js";

export default definePluginEntry({
  id: "dsa-workbench",
  name: "DSA Workbench",
  description: "Saved stock reports and a private same-origin original DSA workbench.",
  register(api) {
    const config = parseConfig(api.pluginConfig);
    api.session.controls.registerControlUiDescriptor({
      surface: "tab", id: "dsa-workbench", label: "股票研究",
      description: "原 DSA 报告概览与完整私人手动工作台", icon: "chart-line",
      group: "agent", order: 40, path: `${ROUTE_ROOT}/`, requiredScopes: ["operator.read"],
    });
    api.registerHttpRoute({
      path: `${ROUTE_ROOT}/`, match: "prefix", auth: "plugin",
      handler: withDsaRouteAccess(createDsaHttpHandler(config), { ...config, logger: api.logger }),
    });
  },
});
