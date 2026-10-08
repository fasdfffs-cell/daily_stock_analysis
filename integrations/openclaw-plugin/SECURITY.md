# Security boundary

## Identity on every route

`auth: "plugin"` is a routing declaration, not authentication by itself. The owner-authored Todo `src/access.ts` guard and synthetic guard regressions were copied (2026-10-08) into this repository, with provenance comments and no external-workspace imports. Every HTML, CSS, original app asset, API read/write and SSE request passes this guard again.

Unforwarded loopback is the same explicit host-process trust boundary as Todo/Parking, tightened to an exact localhost/127.0.0.1/[::1] Host authority to reject unknown/public-host DNS rebinding. Cloudflare requests require a loopback peer, precise configured Host/HTTPS forwarding, no mixed ingress, a bounded single RS256 JWT, fixed Cloudflare issuer-derived JWKS URL, no redirects, bounded key set/body/timeouts and RSA >=2048-bit signatures. Exact issuer, configured audience membership, expiry/nbf, bounded nonempty email claim and (if configured) exact email restriction are checked each request. Empty optional email preserves Access application policy; it does not disable signature or identity verification. Tailscale requires no CF/Funnel/mixed headers, one client address/login and a fresh fixed-argv `whois` identity match. Unverified proxy headers never downgrade to local trust. No JWT/cookie/claim/secret values are logged.

The existing guard deliberately does not use Cloudflare forwarding client-IP metadata as authorization; the signature and host/protocol are decisive. Raw non-loopback traffic is denied even with otherwise plausible headers. A malicious process already within the trusted host is outside the browser CSRF boundary.

## Original app and writes

The sidebar is escaped server-rendered text; no raw Markdown/HTML injection, scripts, forms, model execution or data fetching. Only original `analysis_history` fixed columns are read in a read-only/query-only SQLite connection, with bounded rows/text and explicit source-view status. `model_used` comes from the saved report, not a runtime configured-model banner. No migrations/creation, auth-file access or user-chosen path exists.

The full original React app remains top-level; no opaque-frame React/CORS workaround, undocumented parent bridge, Gateway bearer, Gateway cookie or frontend Access token is introduced. Its mandatory authentication is enforced by the DSA backend **and** a bounded auth-status check before every proxied operation; disabling backend auth fails closed. No production password is set/read or copied by the plugin.

Writes require exact real ingress Origin, no cross-site/null Origin, bounded single Content-Length, no chunked/compressed/upgrade, bounded UTF-8 JSON and per-action fields. Upload/text import is denied rather than proxied. Only login/password-change/logout, single-US-symbol analysis (`notify=false`), watchlist add/remove and scoped cancel are writable. Read allowlist covers auth/workbench status, watchlist, history/details/news/Markdown/diagnostics/flow and tasks/status/SSE. Config/import/export/auth-disable, Agent, notification, scheduler, broker/portfolio, screening/backtest and unknown APIs fail closed. These are only a second perimeter: DSA's manual-mode sink and login/Origin defenses remain active.

Only `dsa_session` is forwarded, with duplicate/invalid/oversized cookie rejection. Gateway/Access authorization and other cookies or forwarding credentials never reach DSA. Upstream session cookies are narrowed to the app prefix, stripped of Domain/foreign attributes and emitted HttpOnly/Secure/SameSite=Lax. Upstream response headers are allowlisted; no CORS wildcard/null output. Strict backend Host remains fixed loopback, and browser Origin is not rewritten to bypass DSA's CSRF checks.

The internal HTTP agent connects only to hardcoded 127.0.0.1/port 8010; a numeric fixture port exists solely as internal test injection, not plugin config or HTTP input. This scoped local application hop avoids routing local HTTP through an ambient outbound credential proxy; globalAgent, proxy environment and protected secret injection remain unchanged. No environment secret is passed into HTTP headers. JWKS uses the normal HTTPS client with a fixed issuer boundary, not this local agent.

No redirect is followed. Only known same-origin `/`, `/login`, `/index.html` redirects become prefixed paths; external or unknown redirects fail. SSE pipes with backpressure, no buffering, a 45s heartbeat deadline and client-disconnect cleanup; fixture verification must outlast 35s, not just see instant mock events. Other responses/body/headers are bounded. Static serving denies traversal/encoded separators/hidden files, symlink components and hardlinks, uses O_NOFOLLOW and checks containment/inode, accepts known file types and no source maps.

## Authority and activation

This is a privately scoped native plugin; review it as Gateway-process code. It adds no global sandbox/trusted policy, native frontend, branding, Gateway SDK change, DNS/tunnel/firewall or runtime-model setting. First plugin loading/install may restart the hosting Gateway, so only the owner performs that step. Temporary fixtures are stopped after evidence is saved. Local SDK/CLI/HTTP/browser proofs do not prove a live sidebar, Access edge authentication or a phone client.
