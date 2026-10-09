#!/usr/bin/env python3
"""Start the original app in an isolated, authenticated manual-only runtime.

Run from the repository. Installs/builds nothing and never invokes main.py.
All model credentials stay in the official CLI's managed configuration.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SAFE_INHERIT = ("PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS")


def prepare_environment(args, inherited):
    runtime = Path(args.runtime_dir).resolve()
    if not runtime.is_relative_to(ROOT) or runtime == ROOT:
        raise ValueError("Runtime directory must be a dedicated directory inside this repository")
    public = urlsplit(args.public_url)
    if public.scheme not in {"http", "https"} or not public.netloc or public.username or public.password or public.query or public.fragment or public.path not in {"", "/"}:
        raise ValueError("PUBLIC_URL must be a token-free root origin")
    binary = shutil.which(args.openclaw) if not Path(args.openclaw).is_absolute() else args.openclaw
    if not binary or not Path(binary).is_file():
        raise ValueError("Official OpenClaw CLI executable was not found")
    if not 1 <= args.port <= 65535:
        raise ValueError("Invalid loopback port")
    for name in ("home", "state", "cache", "logs", "tmp"):
        directory = runtime / name
        if directory.is_symlink() or not directory.resolve().is_relative_to(runtime):
            raise ValueError("Runtime state/home/cache paths must not escape through symlinks")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)
    env_file = runtime / "state" / "watchlist.env"
    if env_file.is_symlink():
        raise ValueError("Watchlist config must not be a symlink")
    if not env_file.exists():
        with env_file.open("x") as file:
            file.write("STOCK_LIST=\n")
        env_file.chmod(0o600)
    env = {k: inherited[k] for k in SAFE_INHERIT if k in inherited}
    env.update({
        "DSA_RUNTIME_MODE": "native_research" if getattr(args, "native_research", False) else "manual_workbench", "HOME": str(runtime / "home"),
        "XDG_CONFIG_HOME": str(runtime / "home" / ".config"),
        "XDG_CACHE_HOME": str(runtime / "cache"), "XDG_DATA_HOME": str(runtime / "state"),
        "TMPDIR": str(runtime / "tmp"), "ENV_FILE": str(env_file),
        "WORKBENCH_STATE_DIR": str(runtime / "state"),
        "DATABASE_PATH": str(runtime / "state" / "analysis.db"),
        "ADMIN_AUTH_ENABLED": "true", "TRUST_X_FORWARDED_FOR": "false",
        "CORS_ALLOW_ALL": "false", "WEBUI_AUTO_BUILD": "false",
        "GENERATION_BACKEND": "openclaw_cli", "GENERATION_FALLBACK_BACKEND": "",
        "GENERATION_BACKEND_TIMEOUT_SECONDS": str(args.model_timeout),
        "GENERATION_BACKEND_MAX_OUTPUT_BYTES": "1048576",
        "GENERATION_BACKEND_MAX_CONCURRENCY": "1", "MAX_WORKERS": "1",
        "OPENCLAW_CLI_BINARY": str(Path(binary).resolve()),
        "OPENCLAW_CLI_HOME": str(Path(args.cli_home).resolve()),
        "OPENCLAW_AGENT": args.agent, "OPENCLAW_THINKING": args.thinking,
        "OPENCLAW_CONFIGURED_TARGET": args.configured_target,
        "DAILY_MARKET_CONTEXT_ENABLED": "false", "BACKTEST_ENABLED": "false", "SCHEDULE_ENABLED": "false", "SCHEDULE_RUN_IMMEDIATELY": "false",
        "STOCK_INDEX_REMOTE_UPDATE_ENABLED": "false", "AGENT_MODE": "false",
        "ENABLE_REALTIME_QUOTE": "false", "ENABLE_REALTIME_TECHNICAL_INDICATORS": "false",
        "ENABLE_CHIP_DISTRIBUTION": "false", "SEARXNG_ENABLED": "false",
        "SOCIAL_SENTIMENT_ENABLED": "false", "INTELLIGENCE_ENABLED": "false",
        "REPORT_INTEGRITY_ENABLED": "false", "REPORT_INTEGRITY_RETRY": "0",
        "TZ": "Asia/Shanghai" if getattr(args, "native_research", False) else "UTC",
        "SCHEDULE_TIME": "19:00", "AGENT_EVENT_MONITOR_ENABLED": "false",
        "PORT": str(args.port), "PUBLIC_URL": args.public_url,
        "LITELLM_LOCAL_MODEL_COST_MAP": "true", "PYTHONNOUSERSITE": "1", "NO_COLOR": "1", "LOG_LEVEL": "INFO",
    })
    return env, runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-research", action="store_true", help="Restore only the original native scheduler and approved research features; schedule defaults disabled")
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "0")))
    parser.add_argument("--public-url", default=os.getenv("PUBLIC_URL", ""))
    parser.add_argument("--runtime-dir", default=str(ROOT / ".workbench"))
    parser.add_argument("--openclaw", default="openclaw")
    parser.add_argument("--cli-home", default=str(Path.home()))
    parser.add_argument("--agent", required=True)
    parser.add_argument("--configured-target", required=True, help="Display-only snapshot; never overrides the managed model")
    parser.add_argument("--thinking", default="", choices=("", "off", "minimal", "low", "medium", "high", "adaptive", "xhigh", "max"))
    parser.add_argument("--model-timeout", type=int, default=600)
    args = parser.parse_args()
    if not 1 <= args.model_timeout <= 600:
        parser.error("Model timeout must be 1..600 seconds")
    env, runtime = prepare_environment(args, dict(os.environ))
    packages = runtime / "packages"
    if not packages.is_dir():
        parser.error("Install requirements-workbench.lock into the isolated runtime packages directory first")
    if not (ROOT / "static" / "index.html").is_file():
        parser.error("Build the original Web frontend explicitly first")
    os.umask(0o077)
    os.environ.clear()
    os.environ.update(env)
    import time
    if hasattr(time, "tzset"):
        time.tzset()  # process-local only; never changes host timezone
    os.chdir(ROOT)
    sys.path[:0] = [str(ROOT), str(packages)]
    from src.config import setup_env, get_config
    setup_env()
    config = get_config()
    from src.llm.openclaw_backend import OpenClawGenerationBackend
    error = OpenClawGenerationBackend(config).get_config_error()
    if error:
        raise error
    from src.logging_config import setup_logging
    setup_logging(log_dir=str(runtime / "logs"), log_prefix="manual_workbench")
    from api.app import app
    import uvicorn
    # No main.py startup/bots/scheduler, reload, auto-build or exposed bind.
    uvicorn.run(app, host="127.0.0.1", port=args.port, proxy_headers=False, access_log=False, timeout_graceful_shutdown=5)


if __name__ == "__main__":
    main()
