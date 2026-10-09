#!/usr/bin/env python3
"""Owner-only offline native schedule settings helper; reads no authentication.

Changes only schedule fields in the explicitly selected watchlist.env via the
same SystemConfigService parser and ConfigManager. A running app must be restarted
by its authorized owner to pick up external helper changes; UI saves reconcile
in process. This helper neither starts/stops services nor executes analysis.
"""
import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', required=True)
    parser.add_argument('--enabled', choices=['true', 'false'])
    parser.add_argument('--time')
    args = parser.parse_args()
    runtime = Path(args.runtime_dir)
    if not runtime.is_absolute() or not runtime.resolve().is_relative_to(ROOT) or runtime.resolve() == ROOT:
        parser.error('Dedicated absolute repository runtime path required')
    for path in [runtime, runtime / 'state', runtime / 'state' / 'watchlist.env']:
        if path.is_symlink():
            parser.error('Symlinks are forbidden')
    env = runtime / 'state' / 'watchlist.env'
    if not env.is_file() or env.stat().st_uid != os.getuid():
        parser.error('Existing owner-owned watchlist.env required')
    sys.path[:0] = [str(ROOT), str(runtime / 'packages')]
    os.environ['DSA_RUNTIME_MODE'] = 'native_research'
    os.environ['ENV_FILE'] = str(env)
    from src.core.config_manager import ConfigManager
    from src.services.system_config_service import SystemConfigService
    from src.services.native_research import SCHEDULE_KEYS, validate_schedule_values
    service = SystemConfigService(manager=ConfigManager(env))
    saved = service._manager.read_config_map()
    if set(saved) - {'STOCK_LIST', *SCHEDULE_KEYS}:
        parser.error('Unsupported configuration fields')
    values = {}
    if args.enabled is not None:
        values['SCHEDULE_ENABLED'] = args.enabled
    if args.time is not None:
        values['SCHEDULE_TIME'] = args.time
    try:
        validate_schedule_values(values)
    except ValueError as exc:
        parser.error(str(exc))
    if values:
        service.update(service._manager.get_config_version(), [{'key': k, 'value': v} for k, v in values.items()], reload_now=False)
        env.chmod(0o600)
    result = {i['key']: i['value'] for i in service.get_config(include_schema=False)['items']}
    print(json.dumps({'schedule': result, 'scheduled_stocks': ['QQQ'], 'timezone': 'Asia/Shanghai', 'run_immediately': False, 'external_changes_require_owner_app_restart': bool(values)}))


if __name__ == '__main__':
    main()
