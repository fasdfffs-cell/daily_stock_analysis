"""Text-only generation through the official managed OpenClaw Gateway CLI.

No shell, configurable argv template, provider credentials, tools or API proxy.
The CLI alone uses its own managed HOME; DSA's HOME remains isolated.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import time
import threading
import re
import uuid
from typing import Any

from src.llm.generation_backend import (
    GenerationCapabilities, GenerationError, GenerationErrorCode, GenerationResult,
)

BACKEND_ID = "openclaw_cli"
_GENERATION_SLOT = threading.BoundedSemaphore(1)
_ACTIVE_LOCK = threading.Lock()
_ACTIVE_CALLS: dict[str, threading.Event] = {}

def active_model_runs() -> list[str]:
    with _ACTIVE_LOCK:
        return list(_ACTIVE_CALLS)

def cancel_model_run(query_id: str) -> bool:
    with _ACTIVE_LOCK:
        event = _ACTIVE_CALLS.get(query_id)
        if event is not None:
            event.set()
        return event is not None

def cancel_all_model_runs() -> None:
    with _ACTIVE_LOCK:
        for event in _ACTIVE_CALLS.values():
            event.set()

MAX_PROMPT_BYTES = 110_000  # serialized JSON incl. system/prompt + fixed params
MAX_ARGV_BYTES = 128_000
CLI_ENV_KEYS = ("PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS")


def _error(code: GenerationErrorCode, reason: str, stage: str = "validation") -> GenerationError:
    # Deliberately omit stdout/stderr/prompt/credentials from public diagnostics.
    return GenerationError(code, stage, False, False, BACKEND_ID, BACKEND_ID, {"reason": reason})


def decode_envelope(data: bytes, max_bytes: int) -> tuple[str, str, str, dict]:
    if len(data) > max_bytes:
        raise _error(GenerationErrorCode.OUTPUT_TOO_LARGE, "CLI envelope exceeds limit")
    try:
        envelope = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise _error(GenerationErrorCode.INVALID_JSON, "CLI did not return a JSON envelope") from None
    if not isinstance(envelope, dict) or envelope.get("ok") is not True or envelope.get("error"):
        raise _error(GenerationErrorCode.SCHEMA_VALIDATION_FAILED, "CLI reports unsuccessful inference")
    if envelope.get("capability") != "model.run" or envelope.get("transport") != "gateway":
        raise _error(GenerationErrorCode.SCHEMA_VALIDATION_FAILED, "Expected a Gateway model.run result")
    provider, model = envelope.get("provider"), envelope.get("model")
    if not all(isinstance(v, str) and 0 < len(v.strip()) <= 200 for v in (provider, model)):
        raise _error(GenerationErrorCode.SCHEMA_VALIDATION_FAILED, "Missing actual provider/model")
    attempts, outputs = envelope.get("attempts"), envelope.get("outputs")
    if not isinstance(attempts, list) or not isinstance(outputs, list) or not outputs:
        raise _error(GenerationErrorCode.SCHEMA_VALIDATION_FAILED, "Missing attempts/outputs schema")
    if any(not isinstance(o, dict) or not isinstance(o.get("text"), str) or o.get("mediaUrl") or o.get("mediaUrls") for o in outputs):
        raise _error(GenerationErrorCode.SCHEMA_VALIDATION_FAILED, "Only text outputs are supported")
    text = "\n".join(o["text"] for o in outputs).strip()
    if not text:
        raise _error(GenerationErrorCode.EMPTY_OUTPUT, "Empty model text")
    return text, provider.strip(), model.strip(), {"reported_attempt_count": len(attempts)}


def cleanup_process_group(process: subprocess.Popen, pgid: int) -> None:
    """Clean the saved start_new_session group even after its leader exits."""
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        # Reap only our leader; descendants may hold pipes after leader exit.
        process.poll()
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        raise _error(GenerationErrorCode.TIMEOUT, "CLI process group did not stop", "cleanup") from None


def gateway_call_argv(combined: str, timeout: float) -> tuple[list[str], str]:
    agent = os.environ["OPENCLAW_AGENT"].lower()
    session_id = f"model-run-{uuid.uuid4()}"
    params = {"agentId": agent, "sessionId": session_id,
              "sessionKey": f"agent:{agent}:explicit:{session_id}", "message": combined,
              "modelRun": True, "promptMode": "none", "cleanupBundleMcpOnRunEnd": True,
              "idempotencyKey": str(uuid.uuid4())}
    thinking = os.getenv("OPENCLAW_THINKING", "")
    if thinking:
        params["thinking"] = thinking
    serialized = json.dumps(params, ensure_ascii=False, separators=(",", ":"))
    argv = [os.environ["OPENCLAW_CLI_BINARY"], "gateway", "call", "agent", "--expect-final",
            "--timeout", str(int(timeout * 1000)), "--json", "--params", serialized]
    if len(serialized.encode()) > MAX_PROMPT_BYTES or sum(len(a.encode()) + 1 for a in argv) > MAX_ARGV_BYTES:
        raise _error(GenerationErrorCode.OUTPUT_TOO_LARGE, "Serialized request exceeds argument budget", "configuration")
    return argv, session_id


def decode_gateway_response(data: bytes, max_bytes: int) -> tuple[str, str, str, dict]:
    """Normalize only a validated final public `agent` modelRun response."""
    if len(data) > max_bytes:
        raise _error(GenerationErrorCode.OUTPUT_TOO_LARGE, "Gateway response exceeds limit")
    try:
        response = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise _error(GenerationErrorCode.INVALID_JSON, "Gateway CLI did not return JSON") from None
    if not isinstance(response, dict) or response.get("status") != "ok" or response.get("error"):
        raise safe_cli_failure(data, b"", 0)
    result = response.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("meta"), dict):
        raise _error(GenerationErrorCode.SCHEMA_VALIDATION_FAILED, "Missing final agent result metadata")
    meta = result["meta"].get("agentMeta")
    if not isinstance(meta, dict):
        raise _error(GenerationErrorCode.SCHEMA_VALIDATION_FAILED, "Missing actual agent model metadata")
    envelope = {"ok": True, "capability": "model.run", "transport": "gateway",
                "provider": meta.get("provider"), "model": meta.get("model"),
                "attempts": meta.get("fallbackAttempts", []), "outputs": result.get("payloads")}
    return decode_envelope(json.dumps(envelope, ensure_ascii=False).encode(), max_bytes)


def safe_cli_failure(stdout: bytes, stderr: bytes, exit_code: int) -> GenerationError:
    # Inspect bounded error material to classify; never expose messages/URLs or
    # arbitrary fields. Only fixed category/stage/status leave this function.
    text = (stdout[:32768] + stderr[:32768]).decode("utf-8", errors="replace").lower()
    category, code = "cli_failure", GenerationErrorCode.NON_ZERO_EXIT
    if any(word in text for word in ("timed out", "timeout", "deadline")):
        category, code = "timeout", GenerationErrorCode.TIMEOUT
    elif any(word in text for word in ("forbidden", "not authorized", "scope", "policy", "permission denied")):
        category, code = "policy", GenerationErrorCode.APPROVAL_REQUIRED
    elif any(word in text for word in ("auth", "unauthorized", "credential", "login required")):
        category, code = "auth", GenerationErrorCode.LOGIN_REQUIRED
    elif any(word in text for word in ("invalid_request", "invalid request", "schema", "params")):
        category, code = "request_validation", GenerationErrorCode.SCHEMA_VALIDATION_FAILED
    elif any(word in text for word in ("rate limit", "rate_limit", "429")):
        category = "provider_rate_limit"
    elif any(word in text for word in ("unavailable", "connection", "econn", "websocket")):
        category = "transport"
    error = _error(code, "Official Gateway modelRun request failed", "gateway")
    error.details.update({"category": category, "status": f"exit_{exit_code}"})
    return error


class OpenClawGenerationBackend:
    backend_id = BACKEND_ID
    capabilities = GenerationCapabilities(True, False, False, False, True, True)

    def __init__(self, config: Any):
        self.config = config

    def get_config_error(self):
        binary = Path(os.getenv("OPENCLAW_CLI_BINARY", ""))
        home = Path(os.getenv("OPENCLAW_CLI_HOME", ""))
        agent = os.getenv("OPENCLAW_AGENT", "")
        if not binary.is_absolute() or not binary.is_file() or not os.access(binary, os.X_OK):
            return _error(GenerationErrorCode.BACKEND_NOT_CONFIGURED, "Set an absolute official CLI executable", "configuration")
        if not home.is_absolute() or not home.is_dir() or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", agent):
            return _error(GenerationErrorCode.UNSAFE_CONFIG, "Invalid managed CLI home/agent", "configuration")
        thinking = os.getenv("OPENCLAW_THINKING", "")
        if thinking and thinking not in {"off", "minimal", "low", "medium", "high", "adaptive", "xhigh", "max"}:
            return _error(GenerationErrorCode.UNSAFE_CONFIG, "Invalid thinking level", "configuration")
        return None

    def generate(self, prompt, generation_config, *, system_prompt=None, stream=False,
                 stream_progress_callback=None, response_validator=None, audit_context=None):
        if not _GENERATION_SLOT.acquire(blocking=False):
            raise _error(GenerationErrorCode.UNKNOWN_BACKEND_ERROR, "Another model request is active", "execution")
        try:
            from src.llm.workbench_lock import shared_model_slot
            try:
                with shared_model_slot():
                    return self._generate(prompt, generation_config, system_prompt=system_prompt, stream=stream,
                                          stream_progress_callback=stream_progress_callback,
                                          response_validator=response_validator, audit_context=audit_context)
            except (OSError, RuntimeError):
                raise _error(GenerationErrorCode.UNKNOWN_BACKEND_ERROR,
                             "Shared model slot busy or unavailable", "execution") from None
        finally:
            _GENERATION_SLOT.release()

    def _generate(self, prompt, generation_config, *, system_prompt=None, stream=False,
                  stream_progress_callback=None, response_validator=None, audit_context=None):
        error = self.get_config_error()
        if error:
            raise error
        combined = f"{system_prompt}\n\n{prompt}" if system_prompt else prompt
        if not isinstance(combined, str) or not combined.strip():
            raise _error(GenerationErrorCode.EMPTY_OUTPUT, "Empty prompt", "configuration")
        timeout = min(max(float(getattr(self.config, "generation_backend_timeout_seconds", 600)), 1), 600)
        argv, session_id = gateway_call_argv(combined, timeout)
        thinking = os.getenv("OPENCLAW_THINKING", "")
        env = {k: os.environ[k] for k in CLI_ENV_KEYS if k in os.environ}
        env["HOME"] = os.environ["OPENCLAW_CLI_HOME"]
        env["NO_COLOR"] = "1"
        limit = min(max(int(getattr(self.config, "generation_backend_max_output_bytes", 1_048_576)), 1024), 4_194_304)
        started = time.monotonic()
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, shell=False, env=env, start_new_session=True)
        pgid = process.pid  # saved before leader can exit; start_new_session sets PGID
        from src.services.run_diagnostics import get_current_diagnostic_context
        context = get_current_diagnostic_context()
        query_id = context.query_id if context is not None else f"local-{process.pid}"
        cancelled = threading.Event()
        with _ACTIVE_LOCK:
            _ACTIVE_CALLS[query_id] = cancelled
        selector = selectors.DefaultSelector()
        stdout, stderr = bytearray(), bytearray()
        selector.register(process.stdout, selectors.EVENT_READ, stdout)
        selector.register(process.stderr, selectors.EVENT_READ, stderr)
        try:
            while selector.get_map():
                if cancelled.is_set():
                    raise _error(GenerationErrorCode.TIMEOUT, "Cancelled by the operator", "execution")
                if time.monotonic() - started > timeout:
                    raise _error(GenerationErrorCode.TIMEOUT, "Managed CLI timed out", "execution")
                for key, _ in selector.select(timeout=0.5):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        key.data.extend(chunk)
                        if len(stdout) + len(stderr) > limit:
                            raise _error(GenerationErrorCode.OUTPUT_TOO_LARGE, "CLI output exceeds budget", "execution")
            process.wait(timeout=2)
            if process.returncode != 0:
                raise safe_cli_failure(bytes(stdout), bytes(stderr), process.returncode)
            text, provider, model, diagnostics = decode_gateway_response(bytes(stdout), limit)
            if response_validator:
                try:
                    response_validator(text)
                except Exception:
                    raise _error(GenerationErrorCode.SCHEMA_VALIDATION_FAILED, "Model report JSON validation failed") from None
        except GenerationError as failure:
            state = os.getenv("WORKBENCH_STATE_DIR")
            if state:
                receipt = {"query_id": query_id, "session_id": session_id, "backend": BACKEND_ID,
                           "ok": False, "stage": failure.stage, "category": failure.details.get("category", failure.error_code.value),
                           "status": failure.details.get("status", failure.error_code.value),
                           "exit_code": process.returncode, "elapsed_seconds": round(time.monotonic()-started, 3),
                           "stdout_bytes": len(stdout), "stderr_bytes": len(stderr)}
                with (Path(state) / "model-failures.jsonl").open("a") as file:
                    file.write(json.dumps(receipt) + "\n")
            raise
        finally:
            try:
                cleanup_process_group(process, pgid)
            finally:
                with _ACTIVE_LOCK:
                    _ACTIVE_CALLS.pop(query_id, None)
                selector.close()
                process.stdout.close()
                process.stderr.close()
        actual = model if model.startswith(provider + "/") else f"{provider}/{model}"
        receipt = {"query_id": query_id, "session_id": session_id, "cli_surface": "gateway.call.agent.modelRun", "client_timeout_seconds": timeout, "backend": BACKEND_ID, "actual_provider": provider, "actual_model": actual,
                   "configured_target": os.getenv("OPENCLAW_CONFIGURED_TARGET") or None,
                   "thinking": thinking or "inherited", "transport": "gateway",
                   "elapsed_seconds": round(time.monotonic() - started, 3),
                   "prompt_sha256": hashlib.sha256(combined.encode()).hexdigest(),
                   "text_sha256": hashlib.sha256(text.encode()).hexdigest(), **diagnostics}
        state = os.getenv("WORKBENCH_STATE_DIR")
        if state:
            with (Path(state) / "model-receipts.jsonl").open("a", encoding="utf-8") as file:
                file.write(json.dumps(receipt) + "\n")
        # CLI currently exposes no usage. Unknown is not zero.
        return GenerationResult(text, actual, provider, BACKEND_ID, {}, raw=receipt, diagnostics=receipt)
