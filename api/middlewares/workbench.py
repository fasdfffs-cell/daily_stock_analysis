"""ASGI guard: explicit MVP allowlist, loopback and browser same-origin writes.

Use raw ASGI so the policy does not buffer SSE responses or request bodies.
Authentication remains the application's own cookie/session implementation.
"""
from __future__ import annotations

import ipaddress
import os
import re
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

from src.workbench import is_manual_workbench, is_native_research


_READ = re.compile(
    r"^/api/v1/(?:auth/status|health|workbench/status|agent/skills|"
    r"system/config/setup/status|stocks/watchlist|"
    r"analysis/(?:tasks|tasks/stream|tasks/[^/]+/flow|status/[^/]+)|"
    r"history(?:/stocks|/[0-9]+(?:/(?:markdown|news|diagnostics|flow))?)?)$"
)
_WRITE = frozenset({
    "/api/v1/auth/login", "/api/v1/auth/logout", "/api/v1/auth/change-password",
    "/api/v1/analysis/analyze", "/api/v1/stocks/watchlist/add",
    "/api/v1/stocks/watchlist/remove",
})


class ManualWorkbenchMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not is_manual_workbench():
            return await self.app(scope, receive, send)
        headers = {k.decode("latin1").lower(): v.decode("latin1") for k, v in scope["headers"]}
        peer = (scope.get("client") or ("", 0))[0]
        try:
            local = ipaddress.ip_address(peer).is_loopback
        except ValueError:
            local = False
        public = urlsplit(os.getenv("PUBLIC_URL", ""))
        port = os.getenv("PORT", "")
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
        if public.netloc:
            hosts.add(public.netloc.lower())
        host = headers.get("host", "").lower()
        reason = None
        if not local or host not in hosts:
            reason = "Only the configured private loopback entry is accepted"
        if scope["method"] not in {"GET", "HEAD", "OPTIONS"}:
            origins = {f"{scope.get('scheme', 'http')}://{host}"}
            if public.scheme and public.netloc:
                origins.add(f"{public.scheme}://{public.netloc}")
            # Require an explicit exact Origin for every write, including CLI
            # clients. A private Portal is not a substitute for DSA CSRF checks.
            origin = headers.get("origin")
            referer = urlsplit(headers.get("referer", ""))
            if not origin or origin not in origins:
                reason = "Cross-origin writes are forbidden"
            if not origin and referer.netloc and f"{referer.scheme}://{referer.netloc}" not in origins:
                reason = "Cross-origin writes are forbidden"
            if headers.get("sec-fetch-site") == "cross-site":
                reason = "Cross-site writes are forbidden"
        path = scope["path"].rstrip("/") or "/"
        if path.startswith("/api/v1/"):
            allowed = (scope["method"] in {"GET", "HEAD"} and bool(_READ.fullmatch(path))) or (
                scope["method"] == "POST" and (path in _WRITE or re.fullmatch(r"/api/v1/workbench/cancel/[A-Za-z0-9_-]{1,100}", path))
            )
            if is_native_research():
                from src.services.research_routes import research_route_allowed
                allowed = allowed or research_route_allowed(path, scope["method"])
            if not allowed:
                reason = "This operation is disabled in the manual workbench"
        if path in {"/docs", "/redoc", "/openapi.json"}:
            reason = "Interactive API configuration is disabled in the manual workbench"
        if reason:
            return await JSONResponse({"error": "workbench_restricted", "message": reason}, status_code=403)(scope, receive, send)
        return await self.app(scope, receive, send)
