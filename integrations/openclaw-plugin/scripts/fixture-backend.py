"""Disposable original DSA auth/history/queue fixture; never use production state."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
p = argparse.ArgumentParser()
p.add_argument('--runtime-dir', required=True)
p.add_argument('--public-origin', required=True)
p.add_argument('--port', required=True, type=int)
args = p.parse_args()
runtime = Path(args.runtime_dir).resolve()
if runtime.parent != ROOT / '.workbench' or not runtime.name.startswith('sidebar-fixture-'):
    raise RuntimeError('Only a fresh task-specific fixture directory is permitted')
if (runtime / 'state' / '.admin_password_hash').exists():
    raise RuntimeError('Refuse to reuse authentication state')
spec = importlib.util.spec_from_file_location('wb', ROOT / 'scripts/workbench.py')
wb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wb)
env, runtime = wb.prepare_environment(SimpleNamespace(runtime_dir=str(runtime), public_url=args.public_origin, port=args.port, openclaw=shutil.which('openclaw'), cli_home=str(runtime / 'home'), agent='fixture', configured_target='DEMO/offline-fixture', thinking='', model_timeout=600), dict(os.environ))
os.environ.clear()
os.environ.update(env)
sys.path[:0] = [str(ROOT), str(ROOT / '.workbench/packages')]
network = []
def block_connect(_socket, address):
    network.append(str(address))
    (runtime / 'state/network-spy.json').write_text(json.dumps(network))
    raise RuntimeError('Fixture outbound network blocked')
socket.socket.connect = block_connect
(runtime / 'state/network-spy.json').write_text('[]')
from src.config import setup_env
setup_env()
from src.llm.openclaw_backend import OpenClawGenerationBackend
def block_model(*_args, **_kwargs):
    raise RuntimeError('Fixture model generation forbidden')
OpenClawGenerationBackend.generate = block_model
from src.analyzer import AnalysisResult
from src.storage import DatabaseManager
result = AnalysisResult(code='NVDA', name='DEMO NVDA', sentiment_score=50, trend_prediction='DEMO', operation_advice='观望', analysis_summary='DEMO — 离线交互验收，不是新模型分析或新行情采样。样例日期 2026-10-07。', model_used='DEMO/offline-fixture', report_language='zh', technical_analysis='DEMO original report rendering only', risk_warning='DEMO — no connected news, not investment advice')
result.raw_response = json.dumps(result.to_dict(), ensure_ascii=False)
DatabaseManager.get_instance().save_analysis_history(result=result, query_id='demo-sidebar-fixture', report_type='detailed', news_content=None, context_snapshot={'market_phase_summary': {'market':'us', 'phase':'postmarket', 'effective_daily_bar_date':'2026-10-07', 'warnings':['DEMO offline fixture']}})
from api.app import app
from api.v1.endpoints import auth as auth_endpoints
original_status = auth_endpoints._get_auth_status_dict
def fixture_status(request=None):
    data = original_status(request)
    data['demoFixture'] = True
    return data
auth_endpoints._get_auth_status_dict = fixture_status
from src.services.analysis_service import AnalysisService
calls = []
def demo_analysis(self, stock_code, **kwargs):
    if kwargs.get('send_notification') is not False:
        raise RuntimeError('Fixture notifications must be disabled')
    callback = kwargs.get('progress_callback')
    for pct in (16, 64, 93):
        if callback:
            callback(pct, 'DEMO offline progress; no model or market-data call')
        time.sleep(0.4)
    calls.append({'stock_code':stock_code, 'demo':True, 'model_calls':0, 'market_data_calls':0})
    (runtime / 'state/analysis-spy.json').write_text(json.dumps(calls))
    return self._build_analysis_response(result, kwargs.get('query_id','demo-sidebar-ui'), report_type='detailed')
AnalysisService.analyze_stock = demo_analysis
(runtime / 'state/fixture-marker.json').write_text(json.dumps({'demo':True,'public_origin':args.public_origin,'auth_initially_empty':True}))
import uvicorn
uvicorn.run(app, host='127.0.0.1', port=args.port, proxy_headers=False, access_log=False, timeout_graceful_shutdown=2)
