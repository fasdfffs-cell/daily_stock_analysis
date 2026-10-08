# DSA Workbench — same-origin OpenClaw entry

This thin private integration preserves the original DSA React/FastAPI manual workbench. After **reviewed artifact activation and a managed Gateway restart**, the `agent` sidebar gets **股票研究** (`dsa-workbench`, order 40). The sidebar at `/plugins/dsa-workbench/` renders saved stock reports using read-only SQLite. The original app opens at the same origin's `/plugins/dsa-workbench/app/`.

The embedded overview contains no scripts, fetches or mutations. A visible **打开完整工作台** link and selectable token-free path are always present. The current external-tab sandbox is `allow-scripts` only, without forms, same-origin or popups: the link's click may be blocked. Long-press/right-click to open separately, or copy the path into the current domain's address bar. Do not treat a click as proof a new tab opened. The full React app is top-level-only (`frame-ancestors 'none'` / `X-Frame-Options: DENY`); its own DSA login is mandatory. No Custom plugin UI lab is needed or enabled by this integration.

## Build, validate and produce the official archive

Build/stage the original prefixed app once (skip rebuilding an already verified unchanged bundle):

```sh
cd apps/dsa-web
npm ci --ignore-scripts --no-audit --no-fund
VITE_MANUAL_WORKBENCH=true VITE_WORKBENCH_BASE_PATH=/plugins/dsa-workbench/app npm run build
cd ../../integrations/openclaw-plugin
node scripts/stage-app.mjs
npm run check
npm test
npm run smoke
openclaw plugins build --root .
openclaw plugins validate --root . --json
# The output must not already exist. Use a private absolute review path.
openclaw plugins pack --root . --out /absolute/private/review/dsa-workbench.tgz --json
```

`plugins build` generates metadata from the actual compiled entry. The public `defineToolPlugin` factory accepts an empty tool list; its normal public `register` hook is composed with the existing descriptor/HTTP registration. This declares **zero agent tools**, session actions, commands, services or privileged RPCs. It preserves the strict eight-field configuration schema instead of accepting unknown configuration or replacing it with an empty schema. No metadata symbols or host loader internals are modified.

Build uses the installed host's SDK/TypeScript; set `OPENCLAW_PACKAGE_ROOT` only for a non-global host. Official packing needs an available esbuild authoring dependency. In a prepared repository that already has the frontend's esbuild, `NODE_PATH="$PWD/../../apps/dsa-web/node_modules" openclaw plugins pack ...` can reuse that installation without downloading packages. No npm runtime dependencies are added to this integration.

The source package retains its build/check/test/smoke scripts. **Do not strip them to manufacture an archive.** Official `plugins pack` alone produces the approval archive with no scripts, install hooks or runtime package dependencies, one bundled backend entry and the generated manifest. It does not copy arbitrary `files` entries. `scripts/embed-resources.mjs` therefore generates literal overview CSS and an exported base64 catalog containing every unchanged original `app/` file (index, CSS, chunks, stock index and other staged resources); the official single backend carries those exact bytes. This catalog is ordinary resource data, not a native browser initializer, privileged action or new HTTP endpoint. Source/generated-resource files and development scripts are not shipped in the approval archive. Verify the extracted official entry with `node scripts/smoke.mjs /absolute/extracted/package/dist/index.js` and `DSA_ARTIFACT_ENTRY=/absolute/extracted/package/dist/index.js node --test test/authoring.test.mjs`.

`static-gateway/` remains a separate ignored frontend build; existing `static/` remains untouched. Empty `VITE_WORKBENCH_BASE_PATH` preserves ordinary root builds. A prefixed bundle rejects `VITE_API_URL`: APIs, SSE, stock index and non-Router login redirects stay on the same prefix. Runtime HTTP file serving deliberately remains the original guarded reader at the admin-selected `staticDir`; an embedded resource catalog does not silently override that path or waive filesystem checks.

## Configuration

Only admin configuration accepts filesystem paths. **Both `dbPath` and `staticDir` are required explicit absolute paths.** `dbPath` points to the existing original DSA analysis database; the sidebar never creates, migrates or writes it. `staticDir` points to the complete matching prefixed app build already staged by the administrator. There is no module-location-derived default: artifact packing cannot preserve such locations. Neither path can be chosen through HTTP requests. The parent activation config must supply both paths and retain the existing app assets at that location.

Remote fields retain Todo/Parking semantics:

- `cloudflareAccessHost`, `cloudflareAccessIssuer`, `cloudflareAccessAudience`: all three set, or all three empty (Cloudflare path disabled).
- `cloudflareAccessEmail`: optional exact restriction after signed JWT validation; empty trusts the Access application's identity policy, **not** unsigned email headers. A nonempty bounded email claim is always required.
- `tailscaleBin` (absolute executable, default `/usr/bin/tailscale`), `tailscaleLogin`: optional existing Serve identity; reverified with `whois` each request. This does not create another remote entry.

Reuse the existing private Access application's host/issuer/AUD/email and TS values via the authorized parent/system configuration merge. Do not copy actual identities into source/docs, alter other plugins, widen Access or add DNS/tunnel/firewall rules. See [SECURITY.md](SECURITY.md).

## Runtime and activation boundary

The proxy target remains fixed `http://127.0.0.1:8010`; no request or config can redirect it. This module never starts/restarts DSA or changes `PUBLIC_URL`. If DSA's existing launcher must switch to the final token-free HTTPS root origin before authenticated writes, that is a separate authorized parent action preserving state, login, Agent/model/thinking and all unrelated settings. Keep strict Host/Origin and loopback-only bind; do not switch the running service before the new route is loaded.

The **successful official pack JSON receipt** contains the exact absolute archive path, full SHA-256, plugin id and `plugin_activate_artifact` request. The authorized parent may submit it through the official System host-management tool for policy/capability review and any required human approval. Approval retains and installs those exact bytes; a legacy npm tarball, changed archive or old HEAD-bound helper is not equivalent. Apply configuration and perform any required managed Gateway restart only through the parent's authorized host-management flow. A terminal is not inherently required when that official tool is available. No install/enable/live configuration/restart is performed by this module or by its authoring tests.

CLI/SDK inspection proves registration only in the inspecting process. It does not prove that the active Gateway loaded the plugin, the live sidebar exists or a remote browser authenticated. Parent must verify loaded route, descriptor, actual saved-report metadata and remote use after approved activation. Artifact approval does not enable Labs or alter the existing sandbox.

Rollback: through supported controls disable/remove only this plugin, preserving the DSA database/auth files and unrelated applications. Restore any separately authorized DSA launcher change only after preserving state. This module creates no scheduler, broker, notification system or permanent HTTP listener.

## Fixture verification (not remote acceptance)

`scripts/fixture-backend.py` only accepts a new `.workbench/sidebar-fixture-*` directory, denies outgoing connections and model generation, and marks auth status `demoFixture=true`. `check-prefix-ui.mjs` refuses auth initialization without that marker; it uses sandboxed system Chrome, a fresh profile and loopback-only origin. It exercises original login, history, watchlist and a DEMO async task plus a real 30-second heartbeat for at least 35 seconds. Localhost acceptance of Secure cookies is **not edge HTTPS/Cloudflare authenticated-phone proof**. Reuse that earlier evidence only when the frontend build is unchanged and its complete asset hashes match; fresh authoring/guard/proxy/static tests and an extracted official-entry SDK/guard test are still required after backend packaging changes.
