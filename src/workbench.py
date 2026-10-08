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
