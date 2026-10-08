# Private manual workbench (opt-in)

This mode keeps the original React/FastAPI application. It is **not** a public deployment, trading bot, scheduler or replacement for an existing reporting system. The first preview supports one Yahoo US symbol per manual request (for example, `NVDA`). History and stock reports are the upstream views.

## Build and start

Use a dedicated ignored runtime directory such as `.workbench/`. Python packages, caches, authentication files, SQLite and private evidence must not be committed. `requirements-workbench.lock` pins the tested wheel-only minimal Python 3.12 runtime, including `tiktoken==0.11.0` (inside the upstream `<0.12` constraint). Install with an isolated pip/venv, `--only-binary=:all:` and a dedicated package target; do not use global pip or unreviewed source installation hooks. This runtime deliberately excludes broker/bot SDKs, external notification clients and newspaper extraction dependencies. Newspaper is imported only when extraction is actually requested in ordinary mode.

```sh
python -m pip install --only-binary=:all: --target .workbench/packages -r requirements-workbench.lock
cd apps/dsa-web
npm ci --ignore-scripts --no-audit --no-fund
VITE_MANUAL_WORKBENCH=true npm run build
cd ../..
PORT=<private-loopback-port> PUBLIC_URL=<token-free-root-origin> \
  python3 scripts/workbench.py --agent <managed-agent> \
  --configured-target <provider/model-snapshot> --thinking max
```

If ensurepip is missing, a hash-verified PyPI pip wheel can bootstrap an isolated target; the build verification receipt records the exact bootstrap used. The launcher never installs packages, builds the frontend or invokes `main.py`/`server.py`. It binds **127.0.0.1 only**, has no reload, and forwards neither arbitrary host environment variables nor credentials to DSA. Only the official CLI subprocess restores its own managed HOME. `--configured-target` is a display-only snapshot; model selection and managed fallbacks remain with the selected Agent. Update that snapshot if the Agent configuration changes. `--thinking` is an explicit one-shot override (omit it to inherit). No global model/policy/pin changes are made. The inspected OpenClaw 2026.9.4 `model run --gateway` implementation has its own fixed 120,000 ms RPC deadline and no timeout flag in help. The wrapper deadline cannot extend that upstream deadline; long max-thinking reports may fail even though the wrapper permits 600 seconds. Do not silently lower thinking or bypass Gateway policy to hide this limitation.

Open the private root-origin entry. On the first visit the original login page asks you to set and confirm your own password. Do this only inside the gated private entry, never in chat. The launcher does not preseed a password. Portal authentication does **not** replace DSA login. Password hash and session secret live beside the isolated database and have owner-only permissions. Cookie sessions remain HttpOnly/SameSite=Lax; HTTPS sets Secure. Authentication cannot be turned off in this mode.

## Enforced boundaries

- Mandatory authentication protects APIs, including SSE. A raw ASGI policy checks the loopback peer, configured Host and exact write Origin; local API clients must also send `Origin: <configured-origin>`. No wildcard CORS or token-query authentication bridge is introduced.
- The backend explicitly allowlists the MVP read/write APIs. Config save/import/export, authentication disablement, scheduler, notification tests, Agent/tool calls, portfolio/broker, backtest, screening and non-MVP operations return 403 even if a button is forged. Retained navigation shows a disabled explanation, not a settings form.
- Lifespan never constructs/restores a scheduler or starts bots, remote stock-index refresh or name-cache warming. Stock autocomplete reads the bundled index only.
- The mutable `watchlist.env` accepts **only STOCK_LIST**. It cannot override immutable runtime mode/model/auth settings. Watchlist updates affect only this runtime's file, not another application or production report task.
- Analysis defaults to `notify=false`, rejects `notify=true`, and the service forces notifications off again. Notification senders and document creation have final sink guards. No automatic market-context/model generation, content-integrity model retry, realtime quotes, chip data, external news, stock-pool sweep or backtest is enabled in the launcher. Yahoo daily bars and fundamental data are allowed only for a manually requested US symbol.
- The `openclaw_cli` backend invokes fixed argv with `shell=False`: `openclaw infer model run --gateway --agent ... --prompt ... --json`, optionally `--thinking`. Prompt text is only one argument, never CLI options. It validates size, exit code, JSON envelope, capability, Gateway transport, text outputs and actual provider/model. It has a 600-second default deadline, bounded output, process-group cleanup and **no DSA retry or provider/API fallback**. OpenClaw's own managed routing may still perform fallbacks; `reported_attempt_count` is not a proof of zero internal retries.
- Cancel an active model request with authenticated `POST /api/v1/workbench/cancel/{query_id}` (Origin required); active ids appear in `/api/v1/workbench/status`. Cancellation stops the local CLI wait/process; it does not prove cancellation of an already accepted provider/Gateway request or reverse its cost. Shutdown requests cancellation of remaining model children. This is not an unbounded background job.

## Report truthfulness

Reports display the **actual provider/model returned by the CLI**, separately from the configured target banner. Model receipts contain hashes/identity/elapsed time, not prompts or credential values. Token usage is unknown when the official envelope omits it, not zero. The CLI raw model probe has no tools or MCP, so model output cannot execute news instructions.

Yahoo prices use the upstream `auto_adjust=True` daily-bar convention. They are not live broker quotes. Report market-phase metadata shows the effective daily-bar date; retrieval time is not the financial period. News is explicitly **not connected**, not silently synthesized. Existing reports and offline fixtures retain their original dates; DEMO fixtures are never described as today's analysis. Numerical consistency, company filings and investment conclusions still require human verification; a successful build/model request is not a financial correctness certification.

## State, verification and rollback

The launcher accepts `--runtime-dir` inside this repository. Its `state/` holds `analysis.db`, `watchlist.env`, `.admin_password_hash`, `.session_secret`, `model-receipts.jsonl` and local reports; `home/`, `cache/`, `tmp/`, `logs/` stay separate from source. Symlink escapes for mutable state/config paths are rejected. Do not copy another application's database/auth files into it. Tests use a separate temporary instance with fixture-only passwords, not the user's auth data.

Run `tests/test_manual_workbench.py`, the selected original auth/generation tests, frontend build/lint and affected React tests. Validate a real sandboxed browser against the local instance, including login, watchlist, report selection and authenticated SSE connection/30-second heartbeats. Local HTTP or browser success does not prove remote Portal delivery; validate that separately through its formal private launch entry without publishing launch tokens.

Stop the reported foreground service process with SIGTERM (or the execution process control tool). There is no permanent service, systemd unit, Docker container, cron, firewall, ingress, Nginx or Gateway mutation to undo. Preserve runtime state before changing branches. Rebuild without `VITE_MANUAL_WORKBENCH=true` and use the ordinary entrypoints for upstream behavior; do not publicly deploy the private preview or push ignored private artifacts.
