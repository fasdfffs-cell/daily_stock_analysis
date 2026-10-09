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

If ensurepip is missing, a hash-verified PyPI pip wheel can bootstrap an isolated target; the build verification receipt records the exact bootstrap used. The launcher never installs packages, builds the frontend or invokes `main.py`/`server.py`. It binds **127.0.0.1 only**, has no reload, and forwards neither arbitrary host environment variables nor credentials to DSA. Only the official CLI subprocess restores its own managed HOME. `--configured-target` is a display-only snapshot; model selection and managed fallbacks remain with the selected Agent. Update that snapshot if the Agent configuration changes. `--thinking` is an explicit one-shot override (omit it to inherit). No global model/policy/pin changes are made. The backend uses the official `gateway call agent --expect-final --timeout` interface to extend only client waiting (at most 600 seconds). Its exact modelRun/raw/no-tools contract is the same as `infer model run --gateway`, whose convenience command has a fixed 120-second wait; no Gateway/provider runtime limit, model/fallback policy or thinking is changed.

Open the private root-origin entry. On the first visit the original login page asks you to set and confirm your own password. Do this only inside the gated private entry, never in chat. The launcher does not preseed a password. Portal authentication does **not** replace DSA login. Password hash and session secret live beside the isolated database and have owner-only permissions. Cookie sessions remain HttpOnly/SameSite=Lax. In manual mode Secure is determined by the validated fixed PUBLIC_URL, even when the backend hop is plain loopback HTTP; arbitrary X-Forwarded-Proto is never trusted. Authentication cannot be turned off in this mode.

## Enforced boundaries

- Mandatory authentication protects APIs, including SSE. A raw ASGI policy checks the loopback peer, configured Host and exact write Origin; local API clients must also send `Origin: <configured-origin>`. No wildcard CORS or token-query authentication bridge is introduced.
- The backend explicitly allowlists the MVP read/write APIs. Config save/import/export, authentication disablement, scheduler, notification tests, Agent/tool calls, portfolio/broker, backtest, screening and non-MVP operations return 403 even if a button is forged. Retained navigation shows a disabled explanation, not a settings form.
- Lifespan never constructs/restores a scheduler or starts bots, remote stock-index refresh or name-cache warming. Stock autocomplete reads the bundled index only.
- The mutable `watchlist.env` accepts **only STOCK_LIST**. It cannot override immutable runtime mode/model/auth settings. Watchlist updates affect only this runtime's file, not another application or production report task.
- Analysis defaults to `notify=false`, rejects `notify=true`, and the service forces notifications off again. Notification senders and document creation have final sink guards. No automatic market-context/model generation, content-integrity model retry, realtime quotes, chip data, external news, stock-pool sweep or backtest is enabled in the launcher. Yahoo daily bars and fundamental data are allowed only for a manually requested US symbol.
- The `openclaw_cli` backend invokes fixed argv with `shell=False`: `openclaw gateway call agent --expect-final --timeout <1–600s-in-ms> --json --params <JSON>`. Fixed JSON sets a new isolated model-run UUID/explicit session key, selected Agent, `modelRun=true`, `promptMode=none`, `cleanupBundleMcpOnRunEnd=true`, idempotency UUID and optional fixed thinking. No model/provider override, chat history, tool/MCP mode, delivery or custom auth is added. Prompt text exists only inside the message field; the whole serialized request including system/prompt/fixed fields is limited to 110KB and total argv to <128KB. Only a validated final status/result/meta/payloads response is normalized; actual provider/model is not inferred from a preset. Failures report fixed stage/category/status, never raw output. It has a 600-second maximum deadline, bounded output and unconditional saved-PGID cleanup: TERM then bounded whole-group wait and KILL, even if the leader exited while descendants retained pipes. There is **no DSA retry or provider/API fallback**. OpenClaw's own managed routing may still perform fallbacks; `reported_attempt_count` is not a proof of zero internal retries.
- Cancel an active model request with authenticated `POST /api/v1/workbench/cancel/{query_id}` (Origin required); active ids appear in `/api/v1/workbench/status`. Cancellation stops the local CLI wait/process; it does not prove cancellation of an already accepted provider/Gateway request or reverse its cost. Shutdown requests cancellation of remaining model children. This is not an unbounded background job.

## Report truthfulness

Reports display the **actual provider/model returned by the CLI**, separately from the configured target banner. Model receipts contain hashes/identity/elapsed time, not prompts or credential values. Token usage is unknown when the official envelope omits it, not zero. The CLI raw model probe has no tools or MCP, so model output cannot execute news instructions.

Manual US history snapshots and Markdown explicitly label the saved complete daily-bar date and USD turnover (the upstream generic CNY unit label is corrected without changing values). The original model output and recommendations remain unchanged. Yahoo prices use the upstream `auto_adjust=True` daily-bar convention. They are not live broker quotes. Report market-phase metadata shows the effective daily-bar date; retrieval time is not the financial period. News is explicitly **not connected**, not silently synthesized. Existing reports and offline fixtures retain their original dates; DEMO fixtures are never described as today's analysis. Numerical consistency, company filings and investment conclusions still require human verification; a successful build/model request is not a financial correctness certification.

## State, verification and rollback

The launcher accepts `--runtime-dir` inside this repository. Its `state/` holds `analysis.db`, `watchlist.env`, `.admin_password_hash`, `.session_secret`, `model-receipts.jsonl` and local reports; `home/`, `cache/`, `tmp/`, `logs/` stay separate from source. Symlink escapes for mutable state/config paths are rejected. Do not copy another application's database/auth files into it. Tests use a separate temporary instance with fixture-only passwords, not the user's auth data.

Run `tests/test_manual_workbench.py`, the selected original auth/generation tests, frontend build/lint and affected React tests. Validate a real sandboxed browser against the local instance, including login, watchlist, report selection and authenticated SSE connection/30-second heartbeats. Local HTTP or browser success does not prove remote Portal delivery; validate that separately through its formal private launch entry without publishing launch tokens.

Stop the reported foreground service process with SIGTERM (or the execution process control tool). There is no permanent service, systemd unit, Docker container, cron, firewall, ingress, Nginx or Gateway mutation to undo. Preserve runtime state before changing branches. Rebuild without `VITE_MANUAL_WORKBENCH=true` and use the ordinary entrypoints for upstream behavior; do not publicly deploy the private preview or push ignored private artifacts.

## Native same-origin OpenClaw entry

The optional repository-owned [DSA Workbench plugin](../integrations/openclaw-plugin/README.md) adds a read-only stock-report sidebar and the **same-domain top-level original React app** at `/plugins/dsa-workbench/app/`. It is not another Portal/port/domain. Build with `VITE_WORKBENCH_BASE_PATH=/plugins/dsa-workbench/app` to produce separate `static-gateway/` assets; default root builds remain compatible. Every route uses the same private Access/Serve identity semantics as Todo/Parking, plus DSA mandatory login and strict browser Origin checks. The iframe stays read-only and supplies an explicit open/copy path; no Gateway credential bridge or sandbox change is needed. Build/validate with the public SDK, then use the exact path and SHA-256 from official `openclaw plugins pack` for parent/System artifact approval; source npm archives are not activation artifacts. The authorized host-management flow can perform reviewed installation and any managed Gateway restart, with human approval when required; a terminal is not inherently required. Keep the existing runtime untouched during authoring. Empty first installation is strictly inert: the whole-prefix route returns a fixed 503 without reading DB, serving the app, verifying identity or opening an agent/proxy. After artifact approval, parent sets complete scoped plugin config through the official System operation and performs the managed registration/restart step; both dbPath and staticDir must be explicit admin absolute paths and configured Access/Serve fields must satisfy the existing all-or-none identity parser before business activates; valid path-only local trust remains unchanged. No automatic inheritance from global config is used. An explicit optional admin-only `accessPolicySource` (`todo` or `parking-trends`) can project just six identity metadata fields from the enabled source in public `api.config`, without exposing the redacted audience through chat; direct fields conflict with that selector and absent/disabled/redacted/incomplete source remains inert. The existing per-request guards are unchanged. The complete unchanged app resources and literal overview CSS are carried inside the single bundled backend for byte-level review, while runtime static serving preserves the configured filesystem guard. Any later DSA launcher PUBLIC_URL change remains a separate authorized parent action. Security and activation/rollback details are in the integration docs.

## Reviewed local QQQ scheduled entry (task creation separate)

`scripts/scheduled_analysis.py` is a trusted **local process** entry, not an API
or authentication bypass. It reuses `prepare_environment` with mandatory web
authentication unchanged, isolated cached packages, agenta/default managed routing,
max thinking, and the existing 600-second official adapter. The validated
`http://localhost`/port 1 origin fields are unused configuration placeholders:
this process starts no listener and imports no web authentication modules. No
password, session secret, cookie or user credential is accepted/read by this entry.

```sh
python3 scripts/scheduled_analysis.py --self-test
python3 scripts/scheduled_analysis.py --check
# Only the separately authorized owner task executes this production command:
python3 scripts/scheduled_analysis.py --symbol QQQ
```

The separate draft schedule is `0 19 * * 1-5`, timezone `Asia/Shanghai`, command
execution timeout 900 seconds, no-output timeout at least 650 seconds, output
limit 8192 bytes, delivery `none`. No agent/model wrapper surrounds this command.
**No scheduler task is created by the source or these verification commands.**
`--check` only returns calendar/context and the next eligible slot; it does not
prepare an environment, open the DB, read auth, or reserve a production slot.
`--self-test` uses temporary fixture state and fake analysis only, disallows network
socket connection and auth-file reads, and never calls the official model CLI.
Production has no fake clock/runtime-path/model override CLI arguments.

At 19:00 Shanghai (any second in that minute), the New York date is the target US
session (07:00 EDT or 06:00 EST). Other times skip, with no delayed catch-up. The
installed `exchange_calendars==4.13.2` XNAS alias resolves to XNYS, sharing US equity
holidays/half days; if XNAS is absent the explicit XNYS shared-equity calendar is
used, never a weekday or China-holiday fallback. Calendar errors fail closed.
Early closes remain eligible. 19:00 is a start time, not a finish-time promise or
access to that night's closing bar. Existing source retrieval, original market
snapshot date/model and history remain authoritative. Saved bar dates later than
the last completed US session or on non-sessions cause explicit failure; stale
complete bars are labelled stale, never relabelled to today's session. Existing
naive `analysis_history.created_at` timestamps are preserved and disclosed as
existing DB local time, separately from UTC runner start/elapsed time.

Only QQQ is allowed. AnalysisService writes the **same**
`.workbench/state/analysis.db` `analysis_history`, so ordinary history/report views
can read it, with no replacement history table or edits to old rows/stock_daily
uniqueness. No notifications, news, market review, realtime, trades or portfolios
are enabled. The runner verifies exactly one saved QQQ/query-id row before success.
Receipts contain references/hashes/source/model, not report bodies or prompts.

Private receipts: `.workbench/state/scheduled-analysis/QQQ/<US-session>.json`
(files 600, directories 700), serialized by nonblocking flock and atomically
replaced/fsynced. `attempt: 0` is persisted **before** service/model work. A failed,
busy or interrupted attempt occupies its date too; repeated invocation returns
bounded `duplicate`/`NO_REPLY` metadata with exit 0 and preserves the original
receipt/report. First busy returns exit 3; analysis/provenance/state errors exit 1.
There is no automatic model retry or unbounded waiting queue. Correcting a failed
slot is a separate reviewed recovery, not a built-in retry switch.

The official backend now additionally uses a nonblocking private
`model-generation.lock` shared by **newly loaded cooperating processes**, without
increasing its existing in-process semaphore of one. A conservative same-user
`/proc` check before scheduled analysis detects active official Gateway/model CLI
waits, excluding serialized params from parsing and never reading environment.
**This snapshot check is not a race-free lock against an already-running old web
process**, and local CLI cancellation is not proof of provider cancellation. Do
not claim full old/new application concurrency protection. Owner review must
settle the old-process maintenance/overlap barrier before enabling the draft;
this source task does not restart or modify the running application.

See `reports/dsa-qqq-schedule-20261009/` for offline evidence and the uncreated owner
job draft. Actual scheduler disabled-task validation, live data/model execution,
remote history visibility and eventual activation remain separate parent proofs.

## Opt-in native research candidate (owner-reviewed cutover only)

Build the same React application with `VITE_NATIVE_RESEARCH=true` (and
`VITE_WORKBENCH_BASE_PATH=/plugins/dsa-workbench/app` for the existing Gateway
entry), then add `--native-research` to the original `scripts/workbench.py`
launch arguments. This opts into a narrowly restored original
`RuntimeSchedulerService` and `SystemConfigService`, not `main.py`, a second cron
framework, new daemon, OpenClaw automation or a new website. The native scheduler
has its own original `schedule.Scheduler` instance with explicit Asia/Shanghai
job timezone; launcher `TZ=Asia/Shanghai` is process-local, not a host change.
No immediate generation, warmup, index refresh or event monitor starts.

Native mode accepts only `STOCK_LIST`, `SCHEDULE_ENABLED`, `SCHEDULE_TIME` in the
isolated `watchlist.env`. Missing schedule keys mean **disabled, 19:00**. Settings
expose only the two schedule fields with the original field metadata and strict
HH:MM validation; QQQ is explicitly fixed/read-only in this supported scope.
Changing a timer never replaces ordinary AAPL/NVDA/etc watchlist entries.
UI saves use the original service and reconcile without immediate execution.
Calendar is pinned exchange_calendars 4.13.2, US equity holiday/early-close aware,
and fails closed. Delayed/missed slots skip with no catch-up. The existing
per-US-session receipt reserves failures and successes alike, preventing an
automatic model retry. The trusted callback uses the original AnalysisService
and saved history, notification final sinks stay disabled, and the managed CLI
retains the shared single-model slot and 600-second ceiling. It never invokes
`main.py` or creates a multiprocessing analysis runtime. Durable slot outcomes
are projected safely after restart; new lifecycle status is not a historical
promise of success. Existing naive DB timestamps are preserved; new process-local
timezone timestamps are not silently migrated or reinterpreted.

Research navigation opens home/history/watchlist, narrow settings, original
portfolio and original backtest. Home watchlist bulk analysis submits one explicit
symbol per request into the existing serial queue; whole-stock history deletion
requires explicit UI confirmation. Bulk-ID and bulk-stock deletion controls are
hidden. Portfolio permits local account/trade/cash/corporate-action ledger only,
uses saved prices/FX and read-only snapshots; missing prices are marked unavailable
and partial, not valid zero value. CSV/broker/FX online updates/position AI/risk
extension are not opened. Manual backtests evaluate saved historical reports/bars;
online bar refill is disabled and insufficient data remains insufficient. No
Agent/chat/news/screening/alerts or automatic backtest is enabled. Data/usage are
not opened: unknown usage is not represented as zero.

Backend and Gateway proxy use exact method/path allowlists; authenticated cookie,
per-request Access/Serve identity, fixed loopback/Origin, cookie path/Secure,
request bounds and ordinary schemas remain. Nested schedule items are bounded;
unknown request fields and non-finite portfolio/backtest numeric input are rejected.
No full config export/import/provider fields/auth disabling is exposed. The plugin
still has nine admin config properties and zero tools, actions or services.

For an explicitly authorized owner staging schedule values without a password:

```sh
python3 scripts/native_research_config.py --runtime-dir "$PWD/.workbench"
python3 scripts/native_research_config.py --runtime-dir "$PWD/.workbench" --enabled false --time 19:00
# Only AFTER the old external schedule is disabled by its owner:
python3 scripts/native_research_config.py --runtime-dir "$PWD/.workbench" --enabled true --time 19:00
```

The helper validates the exact existing owned file and applies only scoped fields
through SystemConfigService/ConfigManager; it reads no auth files and performs no
HTTP/admin-cookie bridge. **Externally staged helper changes require an authorized
app restart**; they do not claim to hot-change a disabled running timer. First
load and review must use disabled config. Parent alone snapshots DB with SQLite
online backup/quick_check, reviews exact source/archive, loads the formal plugin
artifact, verifies registered+disabled state, disables the old owner, then enables
native through the UI or helper plus authorized app restart. Backend must stay up;
no permanent service or downtime replay is provided by this candidate. Never leave
both owners enabled. Source/build/fixture success is not production loading or
financial-correctness proof.
