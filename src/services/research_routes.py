"""Exact native research API additions; no broker/import/providers/agent paths."""
import re

_RULES = (
    (r"/api/v1/system/(?:config|scheduler/status)", {"GET", "HEAD"}),
    (r"/api/v1/system/config", {"PUT"}),
    (r"/api/v1/history/by-code/[A-Z][A-Z0-9.\-]{0,14}", {"DELETE"}),
    (r"/api/v1/portfolio/(?:accounts|trades|cash-ledger|corporate-actions|snapshot)", {"GET", "HEAD"}),
    (r"/api/v1/portfolio/(?:accounts|trades|cash-ledger|corporate-actions)", {"POST"}),
    (r"/api/v1/portfolio/accounts/[1-9][0-9]{0,9}", {"PUT", "DELETE"}),
    (r"/api/v1/portfolio/(?:trades|cash-ledger|corporate-actions)/[1-9][0-9]{0,9}", {"DELETE"}),
    (r"/api/v1/backtest/(?:results|performance|performance/[A-Z][A-Z0-9.\-]{0,14})", {"GET", "HEAD"}),
    (r"/api/v1/backtest/run", {"POST"}),
)


def research_route_allowed(path, method):
    return any(method in methods and re.fullmatch(pattern, path) for pattern, methods in _RULES)
