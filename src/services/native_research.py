"""Narrow native research adapter; the original RuntimeSchedulerService owns time.

This module restores no main pipeline, warmups, event monitor, notifications or
extra timer. QQQ is an explicit supported restriction, independent of watchlist.
"""
from __future__ import annotations

from datetime import datetime, timezone
import os
import json
import stat
from pathlib import Path
import re
from types import SimpleNamespace
import threading

from src.core.config_manager import ConfigManager

SCHEDULE_KEYS = frozenset({"SCHEDULE_ENABLED", "SCHEDULE_TIME"})
_CONFIG_LOCK = threading.RLock()


def validate_schedule_values(values):
    if set(values) - SCHEDULE_KEYS:
        raise ValueError("Only native schedule fields are accepted")
    if "SCHEDULE_ENABLED" in values and values["SCHEDULE_ENABLED"] not in {"true", "false"}:
        raise ValueError("SCHEDULE_ENABLED must be true or false")
    if "SCHEDULE_TIME" in values and not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", values["SCHEDULE_TIME"]):
        raise ValueError("SCHEDULE_TIME must be HH:MM")


def native_config():
    values = ConfigManager().read_config_map()
    if set(values) - {"STOCK_LIST", *SCHEDULE_KEYS}:
        raise ValueError("Unsupported research configuration key")
    schedule_values = {k: v for k, v in values.items() if k in SCHEDULE_KEYS}
    validate_schedule_values(schedule_values)
    return SimpleNamespace(schedule_enabled=values.get("SCHEDULE_ENABLED", "false") == "true",
        schedule_time=values.get("SCHEDULE_TIME", "19:00"), schedule_times=[],
        agent_event_monitor_enabled=False)


def native_callback(config, args, stock_codes):
    from scripts.scheduled_analysis import calendar, context, execute
    from src.services.analysis_service import AnalysisService
    cal, name = calendar()  # Pinned exchange calendar; error propagates fail-closed.
    now = datetime.now(timezone.utc)
    ctx = context(now, cal, name, config.schedule_time)
    # Never replay a stale due occurrence following suspend/maintenance.
    scheduled_for = getattr(args, "_scheduled_for", None)
    if scheduled_for is None:
        return {"status": "skipped_no_occurrence"}
    if scheduled_for.tzinfo is None:
        scheduled_for = scheduled_for.astimezone()
    from scripts.scheduled_analysis import SH
    due = scheduled_for.astimezone(SH)
    if due.strftime("%Y-%m-%d %H:%M") != now.astimezone(SH).strftime("%Y-%m-%d %H:%M"):
        return {"status": "skipped_missed_slot"}
    result, code = execute(ctx, cal, Path(os.environ["WORKBENCH_STATE_DIR"]), AnalysisService)
    if code:
        raise RuntimeError(result.get("category", "native_analysis_failed"))
    return result


def native_status(scheduler):
    from scripts.scheduled_analysis import calendar, next_slot
    config = native_config()
    status = scheduler.status()
    # Fixed public projection. Never raw configs/paths/provider output.
    projection = {key: status[key] for key in ("enabled", "running", "schedule_times", "last_run_at",
        "last_success_at", "last_skipped_at", "last_skip_reason")}
    projection.update(registered=True, owner="DSA RuntimeSchedulerService", timezone="Asia/Shanghai",
        scheduled_stocks=["QQQ"], stocks_editable=False, run_immediately=False,
        last_error="native_run_failed" if status["last_error"] else None,
        next_run_at=None, next_eligible_at=None, calendar_error=None)
    if status["last_run_at"] is None:
        # Restore only fixed outcome/time fields from the existing durable slot
        # receipt. Never expose prompts, report bodies, auth, paths or raw errors.
        directory = Path(os.environ["WORKBENCH_STATE_DIR"]) / "scheduled-analysis" / "QQQ"
        try:
            if directory.is_dir() and not directory.is_symlink() and not directory.parent.is_symlink():
                candidates = sorted((p for p in directory.iterdir() if re.fullmatch(r"\d{4}-\d{2}-\d{2}\.json", p.name)), reverse=True)
                if candidates:
                    fd = os.open(candidates[0], os.O_RDONLY | os.O_NOFOLLOW)
                    with os.fdopen(fd) as file:
                        info = os.fstat(file.fileno())
                        if not stat.S_ISREG(info.st_mode) or info.st_size > 8192:
                            raise ValueError("Invalid native receipt")
                        receipt = json.load(file)
                    if receipt.get("symbol") != "QQQ" or receipt.get("status") not in {"success", "failed", "busy", "attempted"}:
                        raise ValueError("Invalid native receipt")
                    stamp = datetime.fromisoformat(receipt["startedAt"]).isoformat()
                    projection["last_run_at"] = stamp
                    if receipt["status"] == "success":
                        projection["last_success_at"] = stamp
                    elif receipt["status"] in {"failed", "attempted"}:
                        projection["last_error"] = "native_previous_run_failed_or_incomplete"
                    else:
                        projection["last_skip_reason"] = "existing_cli_active"
        except (OSError, ValueError, TypeError, KeyError):
            projection["last_error"] = "native_receipt_unavailable"
    if status["enabled"]:
        try:
            cal, name = calendar()
            projection["next_eligible_at"] = next_slot(datetime.now(timezone.utc), cal, name, config.schedule_time)
            projection["next_run_at"] = projection["next_eligible_at"]
        except Exception:
            projection["calendar_error"] = "calendar_unavailable_fail_closed"
    return projection


def scoped_config(service, include_schema=True):
    values = service._manager.read_config_map()
    validate_schedule_values({k: v for k, v in values.items() if k in SCHEDULE_KEYS})
    from src.core.config_registry import get_field_definition
    defaults = {"SCHEDULE_ENABLED": "false", "SCHEDULE_TIME": "19:00"}
    items = []
    for key, default in defaults.items():
        item = {"key": key, "value": values.get(key, default), "raw_value_exists": key in values, "is_masked": False}
        if include_schema:
            item["schema"] = get_field_definition(key, item["value"])
        items.append(item)
    return {"config_version": service._manager.get_config_version(), "mask_token": "******",
        "items": items, "llm_model_providers": [], "updated_at": service._manager.get_updated_at()}


def scoped_update(service, version, items, reload_now=True):
    from src.services.system_config_service import ConfigConflictError, ConfigValidationError
    with _CONFIG_LOCK:
        if version != service._manager.get_config_version():
            raise ConfigConflictError(service._manager.get_config_version())
        try:
            if len(items) > 2 or len({i["key"] for i in items}) != len(items):
                raise ValueError("Duplicate or excessive schedule fields")
            values = {i["key"]: i["value"] for i in items}
            validate_schedule_values(values)
        except (ValueError, KeyError):
            raise ConfigValidationError([{"key": "SCHEDULE_TIME", "severity": "error", "message": "Only valid schedule fields are accepted", "code": "native_scope"}]) from None
        updated, skipped, new_version = service._manager.apply_updates(values.items(), set(), "******")
        # No ordinary singleton/tool/news reset. Watchlist and immutable model
        # configuration are untouched. The scheduler provider reads this file.
        if reload_now and service._runtime_scheduler is not None:
            service._runtime_scheduler.reconcile_from_config(run_immediately=False)
        return {"success": True, "config_version": new_version, "applied_count": len(updated),
            "skipped_masked_count": len(skipped), "reload_triggered": bool(reload_now),
            "updated_keys": updated, "warnings": []}
