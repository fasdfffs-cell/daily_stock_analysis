"""Deterministic policy/auth/CLI tests; no live models, news or notifications."""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from src.llm.generation_backend import GenerationError, GenerationErrorCode
from src.llm.openclaw_backend import OpenClawGenerationBackend, decode_envelope


def envelope(text='{"ok":true}'):
    return {"ok": True, "capability": "model.run", "transport": "gateway", "provider": "fixture", "model": "demo", "attempts": [], "outputs": [{"text": text, "mediaUrl": None}]}


def gateway_response(text='{"ok":true}'):
    return {"runId": "fixture-run", "status": "ok", "result": {
        "meta": {"agentMeta": {"provider": "fixture", "model": "demo", "fallbackAttempts": []}},
        "payloads": [{"text": text, "mediaUrl": None, "mediaUrls": None}]}}


@pytest.mark.parametrize("change,code", [
    ({"ok": False}, GenerationErrorCode.SCHEMA_VALIDATION_FAILED),
    ({"transport": "local"}, GenerationErrorCode.SCHEMA_VALIDATION_FAILED),
    ({"provider": ""}, GenerationErrorCode.SCHEMA_VALIDATION_FAILED),
    ({"attempts": None}, GenerationErrorCode.SCHEMA_VALIDATION_FAILED),
    ({"outputs": []}, GenerationErrorCode.SCHEMA_VALIDATION_FAILED),
    ({"outputs": [{"text": " "}]}, GenerationErrorCode.EMPTY_OUTPUT),
    ({"outputs": [{"text": "hi", "mediaUrl": "https://invalid.test"}]}, GenerationErrorCode.SCHEMA_VALIDATION_FAILED),
])
def test_envelope_rejects_invalid(change, code):
    value = envelope(); value.update(change)
    with pytest.raises(GenerationError) as raised:
        decode_envelope(json.dumps(value).encode(), 4096)
    assert raised.value.error_code == code
    assert not raised.value.retryable and not raised.value.fallbackable


def test_envelope_json_size_actual_identity():
    with pytest.raises(GenerationError):
        decode_envelope(b"not-json", 4096)
    with pytest.raises(GenerationError) as error:
        decode_envelope(b"x" * 4097, 4096)
    assert error.value.error_code == GenerationErrorCode.OUTPUT_TOO_LARGE
    assert decode_envelope(json.dumps(envelope()).encode(), 4096)[1:3] == ("fixture", "demo")


@pytest.fixture
def fake_cli(tmp_path, monkeypatch):
    home = tmp_path / "managed-home"; home.mkdir()
    binary = tmp_path / "cli"
    binary.write_text(f"#!{sys.executable}\nimport json,sys,os\nfrom pathlib import Path\nPath(os.environ['HOME'],'receipt.json').write_text(json.dumps({{'argv':sys.argv[1:],'env_keys':list(os.environ)}}))\nprint({json.dumps(gateway_response())!r})\n")
    binary.chmod(0o700)
    monkeypatch.setenv("OPENCLAW_CLI_BINARY", str(binary))
    monkeypatch.setenv("OPENCLAW_CLI_HOME", str(home))
    monkeypatch.setenv("OPENCLAW_AGENT", "fixture_agent")
    monkeypatch.setenv("OPENCLAW_THINKING", "max")
    monkeypatch.delenv("WORKBENCH_STATE_DIR", raising=False)
    return binary, home


def test_fixed_argv_no_shell_no_credential_environment(fake_cli, monkeypatch):
    binary, home = fake_cli
    monkeypatch.setenv("QQ_APP_SECRET", "synthetic-do-not-inherit")
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-do-not-inherit")
    text = "--model bad/route; $(touch never)\n--local"
    result = OpenClawGenerationBackend(SimpleNamespace()).generate(text, {}, system_prompt="system")
    receipt = json.loads((home / "receipt.json").read_text())
    argv = receipt["argv"]
    assert argv[:8] == ["gateway", "call", "agent", "--expect-final", "--timeout", "600000", "--json", "--params"]
    params = json.loads(argv[8])
    assert set(params) == {"agentId", "sessionId", "sessionKey", "message", "thinking", "modelRun", "promptMode", "cleanupBundleMcpOnRunEnd", "idempotencyKey"}
    assert params["agentId"] == "fixture_agent" and params["thinking"] == "max"
    assert params["message"] == "system\n\n" + text
    assert params["modelRun"] is True and params["promptMode"] == "none" and params["cleanupBundleMcpOnRunEnd"] is True
    assert params["sessionId"].startswith("model-run-")
    assert params["sessionKey"] == f'agent:fixture_agent:explicit:{params["sessionId"]}'
    assert params["idempotencyKey"] != params["sessionId"]
    assert "provider" not in params and "model" not in params and "tools" not in params
    assert "QQ_APP_SECRET" not in receipt["env_keys"] and "OPENAI_API_KEY" not in receipt["env_keys"]
    assert result.model == "fixture/demo" and result.backend == "openclaw_cli"
    assert result.usage == {}  # not invented zero-token usage


@pytest.mark.parametrize("body,code", [
    ("import sys; sys.exit(7)", GenerationErrorCode.NON_ZERO_EXIT),
    ("print('bad json')", GenerationErrorCode.INVALID_JSON),
    ("print('x'*5000)", GenerationErrorCode.OUTPUT_TOO_LARGE),
    ("import time; time.sleep(5)", GenerationErrorCode.TIMEOUT),
])
def test_cli_failure_bounds_and_no_retry(fake_cli, body, code):
    binary, _ = fake_cli
    binary.write_text(f"#!{sys.executable}\n{body}\n")
    config = SimpleNamespace(generation_backend_max_output_bytes=1024, generation_backend_timeout_seconds=1)
    with pytest.raises(GenerationError) as raised:
        OpenClawGenerationBackend(config).generate("fixture", {})
    assert raised.value.error_code == code
    assert not raised.value.retryable and not raised.value.fallbackable


def test_prompt_limit_and_report_validator(fake_cli):
    with pytest.raises(GenerationError):
        OpenClawGenerationBackend(SimpleNamespace()).generate("x" * 110001, {})
    def invalid(_):
        raise ValueError("fixture schema failure")
    with pytest.raises(GenerationError) as raised:
        OpenClawGenerationBackend(SimpleNamespace()).generate("fixture", {}, response_validator=invalid)
    assert raised.value.error_code == GenerationErrorCode.SCHEMA_VALIDATION_FAILED


@pytest.fixture
def manual_client(tmp_path, monkeypatch):
    state = tmp_path / "state"; state.mkdir()
    config = state / "watchlist.env"; config.write_text("STOCK_LIST=\n")
    for key, value in {
        "DSA_RUNTIME_MODE": "manual_workbench", "ENV_FILE": str(config),
        "DATABASE_PATH": str(state / "test.db"), "WORKBENCH_STATE_DIR": str(state),
        "PORT": "18102", "PUBLIC_URL": "http://127.0.0.1:18102/",
        "ADMIN_AUTH_ENABLED": "false", "GENERATION_BACKEND": "openclaw_cli",
        "GENERATION_FALLBACK_BACKEND": "", "STOCK_INDEX_REMOTE_UPDATE_ENABLED": "false",
    }.items(): monkeypatch.setenv(key, value)
    from src.config import Config
    from src import auth
    Config.reset_instance()
    for key in ("_auth_enabled", "_session_secret", "_password_hash_salt", "_password_hash_stored"):
        monkeypatch.setattr(auth, key, None)
    monkeypatch.setattr(auth, "_rate_limit", {})
    from api.app import create_app
    with TestClient(create_app(), base_url="http://127.0.0.1:18102", client=("127.0.0.1", 32100)) as client:
        client.headers = {"Origin": "http://127.0.0.1:18102"}
        # The upstream TestClient compatibility shim does not expose mutable
        # defaults; wrap fixture writes with the real browser Origin instead.
        original_post = client.post
        def post(url, **kwargs):
            kwargs.setdefault("headers", {"Origin": "http://127.0.0.1:18102"})
            return original_post(url, **kwargs)
        client.post = post
        yield client, state
    Config.reset_instance()


def login(client):
    response = client.post("/api/v1/auth/login", json={"password": "FixtureOnly-NotARealSecret", "passwordConfirm": "FixtureOnly-NotARealSecret"}, headers={"Origin": "http://127.0.0.1:18102"})
    assert response.status_code == 200, response.text
    assert "httponly" in response.headers["set-cookie"].lower()
    assert "samesite=lax" in response.headers["set-cookie"].lower()


def test_mandatory_auth_first_setup_and_logout(manual_client):
    client, state = manual_client
    assert client.get("/api/v1/auth/status").json()["authEnabled"] is True
    assert client.get("/api/v1/stocks/watchlist").status_code == 401
    assert client.get("/api/v1/analysis/tasks/stream").status_code == 401
    assert client.get("/api/v1/workbench/status").status_code == 401
    login(client)
    assert (state / ".admin_password_hash").stat().st_mode & 0o777 == 0o600
    assert client.get("/api/v1/workbench/status").json()["notifications_enabled"] is False
    assert client.post("/api/v1/auth/settings", json={"authEnabled": False}).status_code == 403
    assert client.post("/api/v1/auth/logout").status_code == 204
    assert client.get("/api/v1/stocks/watchlist").status_code == 401


def test_disabled_routes_origin_host_and_notify(manual_client, monkeypatch):
    client, _ = manual_client
    login(client)
    for path in ("system/config/export", "system/config", "portfolio/accounts", "backtest/results", "agent/chat", "intelligence/overview"):
        assert client.get("/api/v1/" + path).status_code == 403
    for path in ("system/config/notifications/test-channel", "system/config/import", "system/scheduler/run-now", "analysis/market-review"):
        assert client.post("/api/v1/" + path, json={}).status_code == 403
    assert client.post("/api/v1/stocks/watchlist/add", json={"stock_code": "NVDA"}, headers={"Origin": "https://evil.invalid"}).status_code == 403
    assert client.get("/health", headers={"Host": "evil.invalid"}).status_code == 403
    assert client.post("/api/v1/analysis/analyze", json={"stock_code": "NVDA", "notify": True}).status_code == 403
    assert client.post("/api/v1/analysis/analyze", json={"stock_codes": ["NVDA", "AMD"]}).status_code == 400
    from api.v1.endpoints import analysis
    from fastapi.responses import JSONResponse
    spy = Mock(return_value=JSONResponse({"fixture": True}))
    monkeypatch.setattr(analysis, "_handle_sync_analysis", spy)
    response = client.post("/api/v1/analysis/analyze", json={"stock_code": "NVDA"})
    # Schema serialization can reject our intentionally tiny fixture; invoke the
    # endpoint directly to isolate the no-notify contract without a model call.
    assert spy.call_args.args[1].notify is False


def test_watchlist_only_configuration_and_final_outbound_sinks(manual_client):
    client, state = manual_client; login(client)
    response = client.post("/api/v1/stocks/watchlist/add", json={"stock_code": "NVDA"})
    assert response.status_code == 200, response.text
    assert "NVDA" in (state / "watchlist.env").read_text()
    from src.core.config_manager import ConfigManager
    with pytest.raises(RuntimeError):
        ConfigManager().apply_updates([("SCHEDULE_ENABLED", "true")], set(), "******")
    from src.notification import NotificationService
    notifier = NotificationService.__new__(NotificationService)
    for name in ("send", "send_with_results", "send_to_context", "send_to_email", "send_to_feishu", "_send_telegram_photo"):
        with pytest.raises(RuntimeError, match="forbids"):
            getattr(notifier, name)("fixture")
    from src.feishu_doc import FeishuDocManager
    manager = FeishuDocManager.__new__(FeishuDocManager)
    manager.client = Mock()
    with pytest.raises(RuntimeError, match="forbids"):
        manager.create_daily_doc("fixture", "fixture")
    assert not manager.client.mock_calls


def test_startup_has_no_scheduler_warmup_network(manual_client, monkeypatch):
    from api import app as module
    from src.services import name_to_code_resolver
    scheduler, refresh, warmup = Mock(), Mock(), Mock()
    monkeypatch.setattr(module, "RuntimeSchedulerService", scheduler)
    monkeypatch.setattr(module, "_schedule_stock_index_background_refresh", refresh)
    monkeypatch.setattr(name_to_code_resolver, "warmup_akshare_cache", warmup)
    import socket
    network = Mock(side_effect=AssertionError("Startup must not connect outbound"))
    monkeypatch.setattr(socket.socket, "connect", network)
    with TestClient(module.create_app(), base_url="http://127.0.0.1:18102", client=("127.0.0.1", 32100)) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/stocks.index.json").status_code == 200
    scheduler.assert_not_called(); refresh.assert_not_called(); warmup.assert_not_called(); network.assert_not_called()


def test_yahoo_only_provider_selection(manual_client):
    from data_provider.base import DataFetcherManager
    manager = DataFetcherManager()
    assert [fetcher.name for fetcher in manager._get_fetchers_snapshot()] == ["YfinanceFetcher"]


def test_cancellation_and_single_generation_slot(fake_cli):
    import threading, time
    from src.llm.openclaw_backend import active_model_runs, cancel_model_run
    binary, _ = fake_cli
    binary.write_text(f"#!{sys.executable}\nimport time; time.sleep(10)\n")
    failures = []
    def run():
        try:
            OpenClawGenerationBackend(SimpleNamespace(generation_backend_timeout_seconds=20)).generate("fixture", {})
        except GenerationError as error:
            failures.append(error)
    worker = threading.Thread(target=run); worker.start()
    deadline = time.monotonic() + 3
    while not active_model_runs() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert active_model_runs()
    with pytest.raises(GenerationError):
        OpenClawGenerationBackend(SimpleNamespace()).generate("second fixture", {})
    assert cancel_model_run(active_model_runs()[0]) is True
    worker.join(5)
    assert not worker.is_alive() and not active_model_runs()
    assert failures[0].details["reason"] == "Cancelled by the operator"


def test_no_automatic_market_context_model(manual_client):
    from src.config import get_config
    from src.core.pipeline import StockAnalysisPipeline
    pipeline = StockAnalysisPipeline(config=get_config(), daily_market_context_enabled=True, daily_market_context_allow_generate=True)
    assert pipeline.daily_market_context_enabled is False
    assert pipeline.daily_market_context_allow_generate is False


@pytest.mark.parametrize("public,xfp,secure", [
    ("http://127.0.0.1:18102/", "https", False),
    ("https://private.invalid/", "http", True),
    ("https://private.invalid/", "https", True),
])
def test_manual_cookie_uses_fixed_public_origin_not_untrusted_forwarded_headers(manual_client, monkeypatch, public, xfp, secure):
    from starlette.requests import Request
    from api.v1.endpoints.auth import _cookie_params
    monkeypatch.setenv("PUBLIC_URL", public)
    monkeypatch.setenv("TRUST_X_FORWARDED_FOR", "true")
    request = Request({"type": "http", "scheme": "http", "server": ("127.0.0.1", 18102), "headers": [(b"x-forwarded-proto", xfp.encode())]})
    assert _cookie_params(request)["secure"] is secure


@pytest.mark.parametrize("ignore_term", [False, True])
def test_cleanup_exited_parent_and_lingering_pipe_child(fake_cli, ignore_term):
    import signal, subprocess, time
    binary, home = fake_cli
    child_code = f"import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM, signal.SIG_IGN if {ignore_term!r} else signal.SIG_DFL);Path({str(home/'ready')!r}).write_text('ready');time.sleep(30)"
    binary.write_text(f"#!{sys.executable}\nimport subprocess,sys,time\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,'-c',{child_code!r}])\nPath({str(home/'descendant.pid')!r}).write_text(str(p.pid))\nwhile not Path({str(home/'ready')!r}).exists(): time.sleep(.01)\nsys.exit(0)\n")
    try:
        with pytest.raises(GenerationError) as failure:
            OpenClawGenerationBackend(SimpleNamespace(generation_backend_timeout_seconds=1)).generate("fixture", {})
        assert failure.value.error_code == GenerationErrorCode.TIMEOUT
        pid = int((home / "descendant.pid").read_text())
        stat = Path(f"/proc/{pid}/stat")
        deadline = time.monotonic() + 1
        while stat.exists() and stat.read_text().split(') ')[1].split()[0] not in {"Z", "X"} and time.monotonic() < deadline:
            time.sleep(0.05)  # bounded kernel SIGKILL delivery, not parent-only wait
        assert not stat.exists() or stat.read_text().split(') ')[1].split()[0] in {"Z", "X"}
        from src.llm.openclaw_backend import active_model_runs
        assert not active_model_runs()
    finally:
        if (home / "descendant.pid").exists():
            try: os.kill(int((home / "descendant.pid").read_text()), signal.SIGKILL)
            except ProcessLookupError: pass


def test_serialized_prompt_json_budget_and_gateway_raw_schema(fake_cli):
    from src.llm.openclaw_backend import decode_gateway_response
    with pytest.raises(GenerationError) as failure:
        OpenClawGenerationBackend(SimpleNamespace()).generate('"' * 60000, {})
    assert failure.value.error_code == GenerationErrorCode.OUTPUT_TOO_LARGE
    data = gateway_response()
    assert decode_gateway_response(json.dumps(data).encode(), 4096)[1:3] == ("fixture", "demo")
    data["result"]["meta"]["agentMeta"]["provider"] = None
    with pytest.raises(GenerationError): decode_gateway_response(json.dumps(data).encode(), 4096)
    with pytest.raises(GenerationError): decode_gateway_response(json.dumps(envelope()).encode(), 4096)


@pytest.mark.parametrize("text,category,code", [
    ('{"error":{"code":"TIMEOUT"}}', 'timeout', GenerationErrorCode.TIMEOUT),
    ('{"error":{"code":"UNAUTHORIZED"}}', 'auth', GenerationErrorCode.LOGIN_REQUIRED),
    ('{"error":{"message":"policy denied"}}', 'policy', GenerationErrorCode.APPROVAL_REQUIRED),
    ('{"error":{"code":"INVALID_REQUEST"}}', 'request_validation', GenerationErrorCode.SCHEMA_VALIDATION_FAILED),
])
def test_safe_gateway_error_category_without_messages(text, category, code):
    from src.llm.openclaw_backend import safe_cli_failure
    value = safe_cli_failure(text.encode(), b'synthetic_secret=do-not-copy', 1)
    assert value.error_code == code and value.stage == 'gateway'
    assert value.details['category'] == category and value.details['status'] == 'exit_1'
    assert 'secret' not in json.dumps(value.details) and 'do-not-copy' not in json.dumps(value.details)


def test_manual_report_daily_date_currency_and_model_disclosure(manual_client):
    from src.workbench import normalize_manual_snapshot, annotate_manual_markdown
    raw = {"model_used": "fixture/actual", "market_snapshot": {"date": "2026-10-07", "close": "237.47", "amount": "193.50 亿元"}}
    before = json.dumps(raw)
    snapshot = normalize_manual_snapshot(raw["market_snapshot"])
    assert snapshot["currency"] == "USD" and snapshot["amount"] == "193.50 亿美元"
    text = annotate_manual_markdown("# Report\n### 📈 当日行情\n| 当前价 | 237.47 |\n| 成交额 | 193.50 亿元 |", raw)
    assert "实际模型：fixture/actual" in text and "日线截至：2026-10-07" in text
    assert "并非实时行情" in text and "完整日线行情（2026-10-07）" in text
    assert "193.50 亿美元" in text and "237.47" in text
    assert json.dumps(raw) == before
