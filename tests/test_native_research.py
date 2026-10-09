"""Native-only research scope tests: temporary DB/auth, no provider or live state."""
from datetime import datetime, timezone
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from src.config import Config
from src.storage import DatabaseManager
from src.services.runtime_scheduler import RuntimeSchedulerService
from src.services.native_research import native_config, native_status, validate_schedule_values
from scripts import scheduled_analysis as scheduled


@pytest.fixture
def native_client(tmp_path, monkeypatch):
    state = tmp_path / 'state'; state.mkdir()
    env = state / 'watchlist.env'; env.write_text('STOCK_LIST=AAPL,NVDA\n')
    for key, value in {
        'DSA_RUNTIME_MODE': 'native_research', 'ENV_FILE': str(env),
        'DATABASE_PATH': str(state / 'analysis.db'), 'WORKBENCH_STATE_DIR': str(state),
        'PUBLIC_URL': 'http://127.0.0.1:18103', 'PORT': '18103',
        'ADMIN_AUTH_ENABLED': 'true', 'GENERATION_BACKEND': 'openclaw_cli',
        'GENERATION_FALLBACK_BACKEND': '', 'STOCK_INDEX_REMOTE_UPDATE_ENABLED': 'false',
        'SCHEDULE_ENABLED': 'false', 'SCHEDULE_RUN_IMMEDIATELY': 'false',
    }.items(): monkeypatch.setenv(key, value)
    from src import auth
    for key in ('_auth_enabled', '_session_secret', '_password_hash_salt', '_password_hash_stored'):
        monkeypatch.setattr(auth, key, None)
    monkeypatch.setattr(auth, '_rate_limit', {})
    Config.reset_instance(); DatabaseManager.reset_instance()
    from api import app as module
    monkeypatch.setattr(module, '_schedule_stock_index_background_refresh', Mock(side_effect=AssertionError('network startup forbidden')))
    application = module.create_app(static_dir=tmp_path / 'empty')
    with TestClient(application, base_url='http://127.0.0.1:18103', client=('127.0.0.1', 1000)) as client:
        yield client, application, state, env
    Config.reset_instance(); DatabaseManager.reset_instance()


def login(client):
    response = client.post('/api/v1/auth/login', json={'password': 'Fixture-NotProduction', 'passwordConfirm': 'Fixture-NotProduction'}, headers={'Origin': 'http://127.0.0.1:18103'})
    assert response.status_code == 200, response.text


def test_disabled_registered_startup_and_auth(native_client):
    client, app, _, _ = native_client
    assert client.get('/api/v1/system/scheduler/status').status_code == 401
    login(client)
    health = client.get('/api/v1/system/scheduler/status').json()
    assert health['registered'] and not health['enabled'] and not health['running']
    assert health['scheduled_stocks'] == ['QQQ'] and not health['stocks_editable']
    assert health['next_eligible_at'] is None and health['last_run_at'] is None
    runtime = app.state.runtime_scheduler_service
    assert runtime._scheduler is None and runtime._thread is None
    assert client.get('/api/v1/workbench/status').json()['mode'] == 'native_research'


def test_scoped_settings_reconcile_watchlist_preserved(native_client, monkeypatch):
    client, app, state, env = native_client; login(client)
    config = client.get('/api/v1/system/config').json()
    assert {i['key'] for i in config['items']} == {'SCHEDULE_ENABLED', 'SCHEDULE_TIME'}
    assert config['llm_model_providers'] == []
    headers = {'Origin': 'http://127.0.0.1:18103'}
    response = client.put('/api/v1/system/config', json={'config_version': config['config_version'], 'items': [{'key': 'SCHEDULE_ENABLED', 'value': 'true'}, {'key': 'SCHEDULE_TIME', 'value': '19:10'}]}, headers=headers)
    assert response.status_code == 200, response.text
    assert 'STOCK_LIST=AAPL,NVDA' in env.read_text()
    runtime = app.state.runtime_scheduler_service
    assert runtime._scheduler is not None
    assert len(runtime._scheduler.schedule.get_jobs()) == 1
    assert runtime._scheduler._background_tasks == [] and runtime._last_run_at is None
    status = client.get('/api/v1/system/scheduler/status').json()
    assert status['enabled'] and '+08:00' in status['next_eligible_at']
    assert status['schedule_times'] == ['19:10']
    # Watchlist saves do not erase native settings.
    assert client.post('/api/v1/stocks/watchlist/add', json={'stock_code': 'MSFT'}, headers=headers).status_code == 200
    assert 'SCHEDULE_TIME=19:10' in env.read_text()
    config = client.get('/api/v1/system/config').json()
    assert client.put('/api/v1/system/config', json={'config_version': config['config_version'], 'items': [{'key': 'SCHEDULE_ENABLED', 'value': 'false'}]}, headers=headers).status_code == 200
    assert runtime._scheduler is None


@pytest.mark.parametrize('key,value', [('OPENAI_API_KEY', 'secret'), ('STOCK_LIST', 'QQQ'), ('ADMIN_AUTH_ENABLED', 'false'), ('SCHEDULE_TIMES','19:00,20:00'), ('SCHEDULE_TIME','24:00'), ('SCHEDULE_TIME','19:0'), ('SCHEDULE_ENABLED','yes')])
def test_native_unknown_or_invalid_settings_fail_closed(native_client, key, value):
    client, _, _, env = native_client; login(client)
    before = env.read_bytes()
    version = client.get('/api/v1/system/config').json()['config_version']
    response = client.put('/api/v1/system/config', json={'config_version': version, 'items':[{'key':key,'value':value}]}, headers={'Origin':'http://127.0.0.1:18103'})
    assert response.status_code == 400, response.text
    assert env.read_bytes() == before


def test_danger_routes_and_cross_origin_fail_closed(native_client):
    client, _, _, _ = native_client; login(client)
    for path in ['system/config/export', 'system/config/schema', 'system/config/generation-backends/status', 'portfolio/import/brokers', 'portfolio/risk', 'agent/chat', 'usage/summary', 'data/overview']:
        assert client.get('/api/v1/'+path).status_code == 403
    for path in ['system/config/import','system/scheduler/run-now','auth/settings','portfolio/fx/refresh','portfolio/positions/QQQ/analysis','analysis/market-review']:
        assert client.post('/api/v1/'+path,json={},headers={'Origin':'http://127.0.0.1:18103'}).status_code == 403
    assert client.delete('/api/v1/history/by-code/QQQ', headers={'Origin':'https://evil.invalid'}).status_code == 403
    assert client.delete('/api/v1/history',json={'record_ids':[1]},headers={'Origin':'http://127.0.0.1:18103'}).status_code == 403


def test_original_manual_portfolio_local_ledger_no_network(native_client, monkeypatch):
    client, _, _, _ = native_client; login(client)
    from src.services.portfolio_service import PortfolioService
    monkeypatch.setattr(PortfolioService, '_fetch_realtime_position_price', Mock(side_effect=AssertionError('quote forbidden')))
    monkeypatch.setattr(PortfolioService, '_fetch_fx_rate_from_yfinance', Mock(side_effect=AssertionError('FX forbidden')))
    headers={'Origin':'http://127.0.0.1:18103'}
    response = client.post('/api/v1/portfolio/accounts',json={'name':'Fixture ledger','market':'us','base_currency':'USD'},headers=headers)
    assert response.status_code == 200,response.text
    account=response.json()['id']
    assert client.post('/api/v1/portfolio/cash-ledger',json={'account_id':account,'event_date':'2026-10-08','direction':'in','amount':1000,'currency':'USD'},headers=headers).status_code == 200
    assert client.post('/api/v1/portfolio/trades',json={'account_id':account,'symbol':'QQQ','trade_date':'2026-10-08','side':'buy','quantity':1,'price':100,'market':'us','currency':'USD'},headers=headers).status_code == 200
    snapshot=client.get('/api/v1/portfolio/snapshot?include_realtime=true').json()
    position=snapshot['accounts'][0]['positions'][0]
    assert position['quantity'] == 1 and not position['price_available']
    assert position['price_source'] == 'missing' and position['data_quality'] != 'ok'
    assert client.post('/api/v1/portfolio/trades',json={'account_id':account,'symbol':'QQQ','trade_date':'2026-10-08','side':'buy','quantity':1,'price':100,'unknown':True},headers=headers).status_code == 422
    assert client.delete('/api/v1/portfolio/accounts/'+str(account),headers=headers).status_code == 200


def test_backtest_native_refill_does_not_construct_provider(native_client, monkeypatch):
    client, _, _, _ = native_client; login(client)
    from src.services.backtest_service import BacktestService
    from data_provider.base import DataFetcherManager
    monkeypatch.setattr(DataFetcherManager,'__init__',Mock(side_effect=AssertionError('provider forbidden')))
    BacktestService(DatabaseManager.get_instance())._try_fill_daily_data(code='QQQ',analysis_date=datetime(2026,10,8).date(),eval_window_days=10)
    response=client.post('/api/v1/backtest/run',json={'code':'QQQ','limit':10},headers={'Origin':'http://127.0.0.1:18103'})
    assert response.status_code == 200,response.text
    assert response.json()['saved'] == 0


def test_inline_original_runtime_dispatch_avoids_main_and_multiprocessing(monkeypatch):
    import multiprocessing
    monkeypatch.setattr(multiprocessing,'get_context',Mock(side_effect=AssertionError('no process')))
    calls=[]
    service=RuntimeSchedulerService(config_provider=lambda:SimpleNamespace(schedule_enabled=True,schedule_time='19:00'),task_runner=lambda config,args,codes:calls.append(args._scheduled_for) or {'status':'success'},inline_task_runner=True)
    when=datetime(2026,10,9,11,tzinfo=timezone.utc)
    service._run_analysis_with_watchdog(scheduled_for=when)
    assert calls == [when] and service._last_success_at is not None and not service._run_lock.locked()


def test_native_calendar_failure_and_stale_occurrence_no_analysis(native_client, monkeypatch):
    from src.services import native_research
    client, _, _, _ = native_client
    monkeypatch.setattr(scheduled,'calendar',Mock(side_effect=scheduled.Closed('calendar_unavailable')))
    with pytest.raises(scheduled.Closed):
        native_research.native_callback(native_config(),SimpleNamespace(_scheduled_for=datetime(2026,10,9,11,tzinfo=timezone.utc)),None)


def test_schema_scope_and_timezone_custom_time():
    cal,name=scheduled.calendar()
    ctx=scheduled.context(datetime.fromisoformat('2026-11-27T19:10:00+08:00'),cal,name,'19:10')
    assert ctx['due'] and ctx['phase']=='premarket' and ctx['tradingSession']
    assert ctx['sessionClose']=='2026-11-27T18:00:00+00:00'
    assert scheduled.next_slot(datetime.fromisoformat('2026-11-26T12:00:00+08:00'),cal,name,'19:10')=='2026-11-27T19:10:00+08:00'


def test_native_actual_pipeline_fixture_42_bars_one_fake_generation(native_client, monkeypatch):
    """Real AnalysisService/pipeline/parser/history; only data+model are fixtures."""
    client, app, state, env = native_client
    import json
    import pandas as pd
    from data_provider.base import DataFetcherManager
    from src.analyzer import GeminiAnalyzer, AnalysisResult
    from src.services import native_research
    cal,name=scheduled.calendar()
    dates=cal.sessions_in_range('2026-08-11','2026-10-08')[-42:]
    frame=pd.DataFrame({'date':[d.date() for d in dates], 'open':[100+i for i in range(42)],
        'high':[102+i for i in range(42)], 'low':[99+i for i in range(42)],
        'close':[101+i for i in range(42)], 'volume':[1000000]*42,
        'amount':[101000000+i*1000000 for i in range(42)], 'pct_chg':[1.0]*42})
    assert len(frame)==42
    monkeypatch.setattr(DataFetcherManager,'get_daily_data',lambda *a,**kw:(frame.copy(),'Yahoo fixture ONLY'))
    monkeypatch.setattr(DataFetcherManager,'get_stock_name',lambda *a,**kw:'DEMO QQQ')
    monkeypatch.setattr(DataFetcherManager,'get_fundamental_context',lambda *a,**kw:{})
    monkeypatch.setattr(GeminiAnalyzer,'get_generation_backend_config_error',lambda self:None)
    calls=[]
    result=AnalysisResult(code='QQQ',name='DEMO QQQ',sentiment_score=50,trend_prediction='震荡',operation_advice='观望',analysis_summary='MOCK fixture; not financial proof',technical_analysis='MOCK 42 bars',risk_warning='MOCK no market claim')
    def fake_generation(self,*a,**kw):
        calls.append(True)
        text=json.dumps(result.to_dict(),ensure_ascii=False)
        if kw.get('response_validator'):kw['response_validator'](text)
        return text,'fixture/not-real',{}
    monkeypatch.setattr(GeminiAnalyzer,'_call_litellm',fake_generation)
    monkeypatch.setenv('ENABLE_REALTIME_QUOTE','false')
    monkeypatch.setenv('ENABLE_CHIP_DISTRIBUTION','false')
    monkeypatch.setenv('REPORT_INTEGRITY_ENABLED','false')
    monkeypatch.setenv('SOCIAL_SENTIMENT_ENABLED','false')
    monkeypatch.setenv('INTELLIGENCE_ENABLED','false')
    monkeypatch.setenv('AGENT_MODE','false')
    monkeypatch.setenv('BACKTEST_ENABLED','false')
    monkeypatch.setenv('REPORT_DIR',str(state/'reports'))
    monkeypatch.setenv('LITELLM_LOCAL_MODEL_COST_MAP','true')
    Config.reset_instance()
    frozen=datetime.fromisoformat('2026-10-09T11:00:10+00:00')
    class Clock(datetime):
        @classmethod
        def now(cls,tz=None):return frozen.astimezone(tz) if tz else frozen.replace(tzinfo=None)
    monkeypatch.setattr(native_research,'datetime',Clock)
    monkeypatch.setattr(scheduled,'cli_busy',lambda:False)
    # execute's default busy callable is intentionally conservative; replace
    # only that injected side effect for deterministic native fixture dispatch.
    original_execute=scheduled.execute
    monkeypatch.setattr(scheduled,'execute',lambda ctx,cal,state,factory:original_execute(ctx,cal,state,factory,busy=lambda:False))
    import socket
    monkeypatch.setattr(socket.socket,'connect',lambda *a,**kw:(_ for _ in ()).throw(AssertionError('fixture network blocked')))
    value=native_research.native_callback(native_config(),SimpleNamespace(_scheduled_for=frozen),None)
    assert value['status']=='success',value
    assert value['latestDailyBar']=='2026-10-08' and value['actualModel']=='fixture/not-real'
    assert len(calls)==1
    duplicate=native_research.native_callback(native_config(),SimpleNamespace(_scheduled_for=frozen),None)
    assert duplicate['status']=='duplicate' and len(calls)==1
    health=native_status(app.state.runtime_scheduler_service)
    assert health['last_run_at'] and health['last_success_at']
