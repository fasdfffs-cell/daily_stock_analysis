"""Opt-in, deliberately restricted manual workbench runtime boundary."""
from __future__ import annotations

import os


def is_manual_workbench() -> bool:
    return os.getenv("DSA_RUNTIME_MODE") == "manual_workbench"


def prohibit_outbound() -> None:
    if is_manual_workbench():
        raise RuntimeError("Manual workbench forbids notifications and document creation")


def workbench_status() -> dict:
    from src.llm.openclaw_backend import active_model_runs
    return {
        "active_model_requests": active_model_runs(),
        "mode": "manual_workbench" if is_manual_workbench() else "standard",
        "backend": "openclaw_cli" if is_manual_workbench() else None,
        "configured_target": os.getenv("OPENCLAW_CONFIGURED_TARGET") or None,
        "thinking": os.getenv("OPENCLAW_THINKING") or "inherited",
        "model_selection": "agent default and managed fallbacks; no model override",
        "notifications_enabled": False if is_manual_workbench() else None,
        "news_status": "not_connected" if is_manual_workbench() else None,
        "data_source": "Yahoo Finance; saved daily bars, not realtime" if is_manual_workbench() else None,
    }


def normalize_manual_snapshot(snapshot):
    """Label Yahoo US daily-bar units; keep every underlying numeric value."""
    if not is_manual_workbench() or not isinstance(snapshot, dict):
        return snapshot
    normalized = dict(snapshot)
    normalized["currency"] = "USD"
    normalized["price_basis"] = "Yahoo auto_adjust daily bars; not realtime"
    amount = normalized.get("amount")
    if isinstance(amount, str):
        normalized["amount"] = amount.replace("亿元", "亿美元").replace("万元", "万美元")
    return normalized


def annotate_manual_markdown(markdown: str, raw_result: dict) -> str:
    """Disclose archived bar date/model and correct upstream CNY headings."""
    if not is_manual_workbench():
        return markdown
    snapshot = normalize_manual_snapshot(raw_result.get("market_snapshot")) or {}
    date = snapshot.get("date") or "未标注"
    model = raw_result.get("model_used") or "未记录"
    note = (f"> 实际模型：{model}。日线截至：{date}；Yahoo 自动复权，币种 USD，"
            "并非实时行情。报告生成日期不是行情日期；财报期间见结构化财报，新闻未接入。\n")
    first, separator, body = markdown.partition("\n")
    text = first + separator + note + body
    text = text.replace("### 📈 当日行情", f"### 📈 完整日线行情（{date}）")
    text = text.replace("| 当前价 |", "| 日线参考价 |")
    # The upstream snapshot amount is daily USD turnover, not a CNY conversion.
    if isinstance(snapshot.get("amount"), str):
        original = (raw_result.get("market_snapshot") or {}).get("amount")
        if isinstance(original, str) and original:
            text = text.replace(original, snapshot["amount"])
    return text
