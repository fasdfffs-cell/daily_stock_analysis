#!/usr/bin/env python3
"""Trusted local QQQ entrypoint; no scheduler, HTTP/auth bridge or delivery."""
from __future__ import annotations

import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from datetime import datetime, time, timedelta, timezone
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import uuid
import time as monotonic_clock
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.workbench'
SH = ZoneInfo('Asia/Shanghai')
NY = ZoneInfo('America/New_York')
KEY = 'dsa-qqq-1900-asia-shanghai-v1'


class Closed(RuntimeError):
    """A fixed, non-sensitive failure category."""


def packages():
    path = RUNTIME / 'packages'
    if path.is_symlink() or not path.is_dir():
        raise Closed('cached_packages_unavailable')
    sys.path[:0] = [str(ROOT), str(path)]


def calendar():
    import exchange_calendars as xc
    if xc.__version__ != '4.13.2':
        raise Closed('calendar_version_mismatch')
    # XNAS is a library alias of XNYS in this pinned version, sharing US equity
    # sessions/holidays/early closes. Do not silently substitute weekdays.
    name = 'XNAS' if 'XNAS' in xc.get_calendar_names() else 'XNYS'
    return xc.get_calendar(name), name


def context(now, cal, name):
    if now.tzinfo is None:
        raise Closed('clock_requires_timezone')
    local = now.astimezone(SH)
    slot = datetime.combine(local.date(), time(19), SH)
    session = slot.astimezone(NY).date().isoformat()
    try:
        trading = bool(cal.is_session(session))
        previous = cal.date_to_session(session, direction='previous')
        if trading:
            previous = cal.previous_session(previous)
        latest = previous.date().isoformat()
        close = cal.session_close(session).isoformat() if trading else None
    except Exception:
        raise Closed('calendar_unavailable') from None
    return {'symbol': 'QQQ', 'localDate': local.date().isoformat(), 'usSession': session,
            'scheduledAt': slot.isoformat(), 'nyScheduledAt': slot.astimezone(NY).isoformat(),
            'calendar': name, 'calendarVersion': '4.13.2', 'tradingSession': trading,
            'sessionClose': close, 'latestCompleteSession': latest,
            'phase': 'premarket' if trading else 'closed',
            'due': local.hour == 19 and local.minute == 0,
            'news': 'not_connected', 'notify': False, 'declarationKey': KEY}


def next_slot(now, cal, name):
    local = now.astimezone(SH)
    for offset in range(370):
        slot = datetime.combine(local.date() + timedelta(days=offset), time(19), SH)
        if slot <= local:
            continue
        ctx = context(slot, cal, name)
        if ctx['tradingSession']:
            return ctx['scheduledAt']
    raise Closed('next_session_unavailable')


def private_tree(path):
    """Check every component without following symlinks; private owned leaf."""
    path = Path(path)
    if not path.is_absolute():
        raise Closed('unsafe_state_path')
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if current.is_symlink():
            raise Closed('symlink_state_path')
        if not current.exists():
            current.mkdir(mode=0o700)
        if not current.is_dir():
            raise Closed('unsafe_state_path')
    if path.stat().st_uid != os.getuid():
        raise Closed('state_owner_mismatch')
    path.chmod(0o700)


def safe_file(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        os.close(fd)
        raise Closed('unsafe_state_file')
    os.fchmod(fd, 0o600)
    return fd


@contextmanager
def slot_lock(directory):
    private_tree(directory.parent)
    private_tree(directory)
    fd = safe_file(directory / '.lock', os.O_CREAT | os.O_RDWR)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
        else:
            yield True
    finally:
        os.close(fd)


def load_receipt(path, ctx):
    if not path.exists() and not path.is_symlink():
        return None
    fd = safe_file(path, os.O_RDONLY)
    with os.fdopen(fd, 'r') as file:
        text = file.read(8193)
    try:
        data = json.loads(text)
        if len(text) > 8192 or not isinstance(data, dict):
            raise ValueError()
        if any(data.get(k) != ctx[k] for k in ('symbol', 'localDate', 'usSession')):
            raise ValueError()
        if data.get('status') not in {'attempted', 'success', 'failed', 'busy'} or data.get('attempt') != 0:
            raise ValueError()
    except (ValueError, TypeError):
        raise Closed('invalid_receipt') from None
    return data


def save_receipt(path, data):
    if path.is_symlink():
        raise Closed('symlink_receipt')
    temporary = path.parent / ('.receipt-' + uuid.uuid4().hex)
    fd = safe_file(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(data, file, sort_keys=True, separators=(',', ':'))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        temporary.unlink(missing_ok=True)


def cli_busy(proc=Path('/proc')):
    """Inspect argv boundary only, never emit/store prompts or read environ."""
    for entry in proc.iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            argv = (entry / 'cmdline').read_bytes().split(b'\0')
            # Params contain the serialized prompt: never parse or log them.
            if b'--params' in argv:
                argv = argv[:argv.index(b'--params')]
            if any(argv[i:i+3] == [b'gateway', b'call', b'agent'] for i in range(len(argv)-2)) and b'--expect-final' in argv:
                # Conservative: all same-user official agent CLI waits block QQQ.
                return True
            if b'infer' in argv and b'model' in argv and b'run' in argv:
                return True
        except FileNotFoundError:
            continue  # process exited during observation
        except PermissionError:
            raise Closed('process_scan_unavailable') from None
    return False


def history(db, query_id, ctx, cal):
    if db.is_symlink() or not db.is_file():
        raise Closed('history_unavailable')
    with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as conn:
        rows = conn.execute('SELECT id,code,raw_result,created_at FROM analysis_history WHERE query_id=?', (query_id,)).fetchall()
    if len(rows) != 1 or rows[0][1] != 'QQQ':
        raise Closed('history_identity_mismatch')
    identifier, _, raw, generated = rows[0]
    try:
        result = json.loads(raw)
        bar = result['market_snapshot']['date']
        bar = datetime.strptime(bar, '%Y-%m-%d').date().isoformat()
        if not cal.is_session(bar) or bar > ctx['latestCompleteSession']:
            raise ValueError()
        model = result['model_used']
        if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:/@+\-]{0,199}', model):
            raise ValueError()
        datetime.fromisoformat(generated)
    except (ValueError, KeyError, TypeError):
        raise Closed('invalid_saved_provenance') from None
    return {'historyId': identifier, 'queryId': query_id, 'latestDailyBar': bar,
            'barFreshness': 'latest_complete' if bar == ctx['latestCompleteSession'] else 'stale',
            'generatedAt': generated, 'generatedAtClock': 'existing_db_naive_local',
            'actualModel': model, 'source': 'Yahoo Finance auto_adjust daily bars',
            'rawResultSha256': hashlib.sha256(raw.encode()).hexdigest()}


def execute(ctx, cal, state, service_factory, busy=cli_busy):
    if not ctx['tradingSession']:
        return {'status': 'skipped_non_session', **ctx}, 0
    if not ctx['due']:
        return {'status': 'skipped_wrong_time', **ctx}, 0
    directory = state / 'scheduled-analysis' / 'QQQ'
    with slot_lock(directory) as owned:
        if not owned:
            return {'status': 'duplicate_busy', 'reply': 'NO_REPLY', **ctx}, 0
        path = directory / (ctx['usSession'] + '.json')
        previous = load_receipt(path, ctx)
        if previous:
            # Failures/crashes reserve the slot too: no automatic model retry.
            return {'status': 'duplicate', 'previousStatus': previous['status'], 'reply': 'NO_REPLY', **ctx}, 0
        query_id = 'scheduled-qqq-' + ctx['usSession']
        started = monotonic_clock.monotonic()
        receipt = {'startedAt': datetime.now(timezone.utc).isoformat(), 'status': 'attempted', 'attempt': 0, 'symbol': 'QQQ',
                   'localDate': ctx['localDate'], 'usSession': ctx['usSession'],
                   'queryId': query_id, 'declarationKey': KEY}
        save_receipt(path, receipt)  # durable before ANY service/model invocation
        try:
            if busy():
                receipt.update(status='busy', category='existing_cli_active')
                save_receipt(path, receipt)
                return {**ctx, **receipt}, 3
            service = service_factory()
            result = service.analyze_stock(stock_code='QQQ', report_type='detailed',
                force_refresh=False, query_id=query_id, send_notification=False,
                analysis_phase='premarket', query_source='scheduled_local_owner')
            if not result or result.get('query_id') != query_id or result.get('stock_code') != 'QQQ':
                raise Closed('analysis_failed')
            saved = history(state / 'analysis.db', query_id, ctx, cal)
            receipt.update(status='success', elapsedSeconds=round(monotonic_clock.monotonic()-started, 3), **saved)
            save_receipt(path, receipt)
            return {**ctx, **receipt}, 0
        except Exception as error:
            category = str(error) if isinstance(error, Closed) else 'analysis_or_state_failed'
            receipt.update(status='failed', category=category, elapsedSeconds=round(monotonic_clock.monotonic()-started, 3))
            save_receipt(path, receipt)
            return {**ctx, **receipt}, 1


def production_service():
    # Public launcher contract; no HTTP app/auth module is imported.
    from scripts.workbench import prepare_environment
    from types import SimpleNamespace
    args = SimpleNamespace(runtime_dir=str(RUNTIME), port=1,
        public_url='http://localhost', openclaw='openclaw', cli_home=str(Path.home()),
        agent='agenta', thinking='max', configured_target='agent-default (display only)',
        model_timeout=600)
    env, runtime = prepare_environment(args, dict(os.environ))
    os.environ.clear()
    os.environ.update(env)
    os.chdir(ROOT)
    from src.config import setup_env, get_config
    setup_env()
    config = get_config()
    from src.llm.openclaw_backend import OpenClawGenerationBackend
    if OpenClawGenerationBackend(config).get_config_error():
        raise Closed('model_backend_not_configured')
    from src.services.analysis_service import AnalysisService
    return AnalysisService()


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument('--symbol', choices=['QQQ'], default='QQQ')
    mode = value.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Read-only calendar/current/next slot; no DB or reservation')
    mode.add_argument('--self-test', action='store_true', help='Offline isolated fixture DB/calendar/lock tests only')
    return value


def main():
    args = parser().parse_args()
    os.umask(0o077)
    logging.disable(logging.CRITICAL)
    try:
        packages()
        if args.self_test:
            import unittest
            import socket
            from unittest.mock import patch
            original_open = Path.open
            def guarded_open(path, *a, **kw):
                if path.name in {'.admin_password_hash', '.session_secret'}:
                    raise Closed('self_test_auth_access_forbidden')
                return original_open(path, *a, **kw)
            with patch.object(socket.socket, 'connect', side_effect=Closed('self_test_network_forbidden')), patch.object(Path, 'open', guarded_open):
                from tests.test_scheduled_analysis import Suite
                result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Suite))
            print(json.dumps({'status': 'self_test', 'tests': result.testsRun,
                'failures': len(result.failures), 'errors': len(result.errors), 'offline': True}))
            return 0 if result.wasSuccessful() else 1
        # Silence library prose; never forward CLI/provider stdout/stderr.
        with open(os.devnull, 'w') as null, redirect_stdout(null), redirect_stderr(null):
            cal, name = calendar()
            now = datetime.now(timezone.utc)
            ctx = context(now, cal, name)
            if args.check:
                output, code = {'status': 'check_only', **ctx, 'nextScheduledAt': next_slot(now, cal, name), 'productionReserved': False}, 0
            else:
                # Reject symlink ancestors BEFORE launcher may resolve them.
                for path in (RUNTIME, RUNTIME / 'state', RUNTIME / 'state' / 'analysis.db'):
                    if path.is_symlink():
                        raise Closed('symlink_production_state')
                output, code = execute(ctx, cal, RUNTIME / 'state', production_service)
        encoded = json.dumps(output, ensure_ascii=True, separators=(',', ':'))
        if len(encoded.encode()) > 8192:
            raise Closed('output_limit')
        print(encoded)
        return code
    except Exception as error:
        print(json.dumps({'status': 'failed', 'symbol': 'QQQ',
            'category': str(error) if isinstance(error, Closed) else 'runner_failed', 'news': 'not_connected'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
