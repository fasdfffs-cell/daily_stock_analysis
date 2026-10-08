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

MAX_PROMPT_BYTES = 110_000  # below Linux's per-argument limit, including system text
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
    if any(not isinstance(o, dict) or not isinstance(o.get("text"), str) or o.get("mediaUrl") for o in outputs):
        raise _error(GenerationErrorCode.SCHEMA_VALIDATION_FAILED, "Only text outputs are supported")
    text = "\n".join(o["text"] for o in outputs).strip()
    if not text:
        raise _error(GenerationErrorCode.EMPTY_OUTPUT, "Empty model text")
    return text, provider.strip(), model.strip(), {"reported_attempt_count": len(attempts)}


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
        if not home.is_absolute() or not home.is_dir() or not agent or not all(c.isalnum() or c in "_-" for c in agent):
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
            return self._generate(prompt, generation_config, system_prompt=system_prompt, stream=stream,
                                  stream_progress_callback=stream_progress_callback,
                                  response_validator=response_validator, audit_context=audit_context)
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
        if len(combined.encode("utf-8")) > MAX_PROMPT_BYTES:
            raise _error(GenerationErrorCode.OUTPUT_TOO_LARGE, "Prompt exceeds argument budget", "configuration")
        argv = [os.environ["OPENCLAW_CLI_BINARY"], "infer", "model", "run", "--gateway",
                "--agent", os.environ["OPENCLAW_AGENT"], "--prompt", combined, "--json"]
        thinking = os.getenv("OPENCLAW_THINKING", "")
        if thinking:
            argv += ["--thinking", thinking]
        env = {k: os.environ[k] for k in CLI_ENV_KEYS if k in os.environ}
        env["HOME"] = os.environ["OPENCLAW_CLI_HOME"]
        env["NO_COLOR"] = "1"
        limit = min(max(int(getattr(self.config, "generation_backend_max_output_bytes", 1_048_576)), 1024), 4_194_304)
        timeout = min(max(float(getattr(self.config, "generation_backend_timeout_seconds", 600)), 1), 1800)
        started = time.monotonic()
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, shell=False, env=env, start_new_session=True)
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
                state = os.getenv("WORKBENCH_STATE_DIR")
                if state:
                    receipt = {"query_id": query_id, "backend": BACKEND_ID, "ok": False,
                               "exit_code": process.returncode, "elapsed_seconds": round(time.monotonic()-started, 3),
                               "stdout_bytes": len(stdout), "stderr_bytes": len(stderr)}
                    with (Path(state) / "model-failures.jsonl").open("a") as file:
                        file.write(json.dumps(receipt) + "\n")
                raise _error(GenerationErrorCode.NON_ZERO_EXIT, "Managed CLI failed; inspect operator-side auth/policy", "execution")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=2)
            with _ACTIVE_LOCK:
                _ACTIVE_CALLS.pop(query_id, None)
            selector.close()
            process.stdout.close()
            process.stderr.close()
        text, provider, model, diagnostics = decode_envelope(bytes(stdout), limit)
        if response_validator:
            try:
                response_validator(text)
            except Exception:
                raise _error(GenerationErrorCode.SCHEMA_VALIDATION_FAILED, "Model report JSON validation failed") from None
        actual = model if model.startswith(provider + "/") else f"{provider}/{model}"
        receipt = {"query_id": query_id, "backend": BACKEND_ID, "actual_provider": provider, "actual_model": actual,
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
