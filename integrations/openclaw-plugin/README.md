# DSA Workbench — native OpenClaw entry

This thin private integration preserves the original DSA React/FastAPI manual workbench. After an **owner-authorized first install and Gateway restart**, the `agent` sidebar gets **股票研究** (`dsa-workbench`, order 40). The sidebar at `/plugins/dsa-workbench/` renders saved stock reports using read-only SQLite. The original app opens at the same origin's `/plugins/dsa-workbench/app/`.

The embedded overview contains no scripts, fetches or mutations. A visible **打开完整工作台** link and selectable token-free path are always present. The current external-tab sandbox is `allow-scripts` only, without forms, same-origin or popups: the link's click may be blocked. Long-press/right-click to open separately, or copy the path into the current domain's address bar. Do not treat a click as proof a new tab opened. The full React app is top-level-only (`frame-ancestors 'none'` / `X-Frame-Options: DENY`); its own DSA login is mandatory.

## Build and verify

From the repository:

```sh
cd apps/dsa-web
npm ci --ignore-scripts --no-audit --no-fund
VITE_MANUAL_WORKBENCH=true VITE_WORKBENCH_BASE_PATH=/plugins/dsa-workbench/app npm run build
cd ../../integrations/openclaw-plugin
npm run check
npm test
npm run smoke
node scripts/stage-app.mjs
npm pack --dry-run
```

`static-gateway/` is a separate ignored bundle; existing `static/` remains untouched. Empty `VITE_WORKBENCH_BASE_PATH` keeps ordinary root builds compatible. A prefixed bundle rejects `VITE_API_URL`: all APIs, SSE, bundled stock index and non-Router login redirects stay on the same prefix. The package contains compiled `dist/`, the staged original `app/` (including all chunks and stock index), `static/overview.css`, manifest and security/usage docs. Build uses the installed host's SDK/TypeScript; set `OPENCLAW_PACKAGE_ROOT` only if OpenClaw is not globally installed. There are no added npm runtime dependencies.

## Configuration

Only admin configuration accepts filesystem paths. `dbPath` is required and absolute, pointing to the existing original DSA analysis database; it is never created, migrated or written by the sidebar. `staticDir` optionally overrides the package's default `app/` with an absolute path to the matching prefixed bundle. Neither path can be chosen through requests.

Remote fields retain Todo/Parking semantics:

- `cloudflareAccessHost`, `cloudflareAccessIssuer`, `cloudflareAccessAudience`: all three set, or all three empty (Cloudflare path disabled).
- `cloudflareAccessEmail`: optional exact restriction after signed JWT validation; empty trusts the Access application's identity policy, **not** unsigned email headers. A nonempty bounded email claim is always required.
- `tailscaleBin` (absolute executable, default `/usr/bin/tailscale`), `tailscaleLogin`: optional existing Serve identity; reverified with `whois` each request. This does not create another remote entry.

Reuse the existing private Access application's host/issuer/AUD/email and existing TS values via a fresh owner-side config merge. Do not copy actual identities into source/docs, change unrelated plugins, widen Access, or add DNS/tunnel/firewall rules. See [SECURITY.md](SECURITY.md).

## Runtime and activation boundary

The proxy target is fixed `http://127.0.0.1:8010`; no request or config can redirect it elsewhere. It does not start/restart DSA or change `PUBLIC_URL`. Before using writes through the final HTTPS origin, the owner/parent must set DSA's existing launcher `PUBLIC_URL` to that **token-free root origin**, preserving isolated state, login, Agent/model/thinking and other settings. Keep DSA's strict Host/Origin and loopback-only bind. Do not switch that running service while the new plugin is not loaded: the old private entry would fail early.

Installed OpenClaw docs and CLI help confirm `openclaw plugins install <local-package.tgz>` and `openclaw plugins inspect dsa-workbench --runtime --json`. Installation/load-path changes can trigger a managed Gateway restart; first load is not a harmless hot reload. Installation/config merge and any restart belong to the **Gateway owner**, after review of the local package and parent activation helper. This module must not invoke install/enable/refresh or restart itself. CLI runtime inspection proves registration in that CLI process only, never active Gateway or remote delivery.

Rollback: owner removes/disables this integration through supported controls and restores the prior DSA root-origin launcher only after preserving state. Do not delete the original DSA database/auth files. This module creates no scheduler, broker, notification system or permanent HTTP listener.

## Fixture verification (not remote acceptance)

`scripts/fixture-backend.py` only accepts a new `.workbench/sidebar-fixture-*` directory, denies outgoing connections and model generation, and marks auth status `demoFixture=true`. `check-prefix-ui.mjs` refuses to initialize auth without that marker; it uses sandboxed system Chrome, fresh profile and a loopback-only origin. It exercises original login, report/history, watchlist and one DEMO async task plus an actual 30-second heartbeat over the prefix for at least 35 seconds. Localhost HTTP may accept Secure cookies as a trustworthy loopback context; this is explicitly **not edge HTTPS/Cloudflare authenticated-phone proof**. Missing host Chinese fonts are a glyph-acceptance limitation, not a reason to install fonts or loosen browser sandbox.
