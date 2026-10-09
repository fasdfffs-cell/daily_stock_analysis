"""Self-contained offline fixtures: no production DB/auth/model/network."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

from scripts import scheduled_analysis as run


class Suite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cal, cls.name = run.calendar()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name) / 'state'
        self.state.mkdir(mode=0o700)
        self.db = self.state / 'analysis.db'
        with sqlite3.connect(self.db) as conn:
            conn.executescript('CREATE TABLE analysis_history(id INTEGER PRIMARY KEY, query_id TEXT, code TEXT, raw_result TEXT, created_at TEXT); CREATE INDEX ix_analysis_code_time ON analysis_history(code,created_at); CREATE TABLE stock_daily(code TEXT,date TEXT,UNIQUE(code,date));')
            conn.execute('INSERT INTO analysis_history VALUES(1,?,?,?,?)', ('old', 'QQQ', '{}', '2026-10-01 01:00:00'))
            conn.execute('INSERT INTO stock_daily VALUES(?,?)', ('QQQ', '2026-10-08'))
        self.calls = []
        self.bar = '2026-10-08'
        self.model = 'fixture/not-real'
        self.fail = False

    def tearDown(self):
        self.tmp.cleanup()

    def ctx(self, value='2026-10-09T19:00:00+08:00'):
        return run.context(datetime.fromisoformat(value), self.cal, self.name)

    def service(self):
        outer = self
        class FakeAnalysisService:
            def analyze_stock(self, **kw):
                outer.calls.append(kw)
                if outer.fail:
                    raise RuntimeError('secret-raw-provider-should-never-appear')
                raw = json.dumps({'market_snapshot': {'date': outer.bar}, 'model_used': outer.model})
                with sqlite3.connect(outer.db) as conn:
                    conn.execute('INSERT INTO analysis_history(query_id,code,raw_result,created_at) VALUES(?,?,?,?)', (kw['query_id'], kw['stock_code'], raw, '2026-10-09 11:01:02'))
                return {'query_id': kw['query_id'], 'stock_code': kw['stock_code']}
        return FakeAnalysisService()

    def execute(self, ctx=None, busy=lambda: False):
        return run.execute(ctx or self.ctx(), self.cal, self.state, self.service, busy)

    def receipt(self):
        return self.state / 'scheduled-analysis/QQQ/2026-10-09.json'

    def test_calendar_regular(self):
        ctx = self.ctx()
        self.assertTrue(ctx['tradingSession'])
        self.assertEqual(ctx['latestCompleteSession'], '2026-10-08')
        self.assertEqual(ctx['nyScheduledAt'], '2026-10-09T07:00:00-04:00')

    def test_holiday_and_weekend_no_state(self):
        for day in ('2026-11-26', '2026-10-10', '2026-10-11'):
            result, code = self.execute(self.ctx(day + 'T19:00:00+08:00'))
            self.assertEqual((result['status'], code), ('skipped_non_session', 0))
        self.assertFalse((self.state / 'scheduled-analysis').exists())
        self.assertEqual(self.calls, [])

    def test_early_close_allowed(self):
        ctx = self.ctx('2026-11-27T19:00:00+08:00')
        self.assertTrue(ctx['tradingSession'])
        self.assertEqual(ctx['sessionClose'], '2026-11-27T18:00:00+00:00')

    def test_dst_and_year_quarter_boundaries(self):
        for value, hour in (('2026-03-06', '06'), ('2026-03-09', '07'), ('2026-10-30', '07'), ('2026-11-02', '06'), ('2026-12-31', '06'), ('2026-04-01', '07')):
            ctx = self.ctx(value + 'T19:00:00+08:00')
            self.assertEqual(ctx['usSession'], value)
            self.assertIn('T'+hour+':00:00', ctx['nyScheduledAt'])

    def test_china_holiday_not_filter(self):
        self.assertTrue(self.ctx('2026-10-01T19:00:00+08:00')['tradingSession'])

    def test_wrong_time(self):
        for clock in ('18:59:59', '19:01:00', '20:00:00'):
            result, code = self.execute(self.ctx('2026-10-09T'+clock+'+08:00'))
            self.assertEqual((result['status'], code), ('skipped_wrong_time', 0))
        self.assertFalse((self.state / 'scheduled-analysis').exists())

    def test_calendar_failure_closed(self):
        class Broken:
            def is_session(self, value):
                raise RuntimeError('no calendar')
        with self.assertRaises(run.Closed):
            run.context(datetime.now(timezone.utc), Broken(), 'XNAS')
        self.assertEqual(self.calls, [])

    def test_service_contract_history_and_duplicate(self):
        result, code = self.execute()
        self.assertEqual((result['status'], code), ('success', 0))
        self.assertEqual(result['latestDailyBar'], '2026-10-08')
        self.assertEqual(result['actualModel'], 'fixture/not-real')
        call = self.calls[0]
        self.assertEqual(call['stock_code'], 'QQQ')
        self.assertFalse(call['send_notification'])
        self.assertFalse(call['force_refresh'])
        self.assertEqual(call['analysis_phase'], 'premarket')
        self.assertEqual(call['query_source'], 'scheduled_local_owner')
        original = self.receipt().read_bytes()
        again, code = self.execute()
        self.assertEqual((again['reply'], code), ('NO_REPLY', 0))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(original, self.receipt().read_bytes())
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute('SELECT id FROM analysis_history WHERE code=? ORDER BY created_at', ('QQQ',)).fetchall(), [(1,), (2,)])
            self.assertEqual(conn.execute('SELECT * FROM stock_daily').fetchall(), [('QQQ', '2026-10-08')])

    def test_failure_reserves_without_retry(self):
        self.fail = True
        result, code = self.execute()
        self.assertEqual((result['status'], code), ('failed', 1))
        self.assertNotIn('secret-raw', json.dumps(result))
        self.execute()
        self.assertEqual(len(self.calls), 1)

    def test_busy_explicit_failure_no_service(self):
        result, code = self.execute(busy=lambda: True)
        self.assertEqual((result['status'], code), ('busy', 3))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.execute()[0]['status'], 'duplicate')

    def test_crash_marker_fail_closed(self):
        directory = self.receipt().parent
        run.private_tree(directory)
        ctx = self.ctx()
        run.save_receipt(self.receipt(), {'status': 'attempted', 'attempt': 0, **{k: ctx[k] for k in ('symbol','localDate','usSession')}})
        self.assertEqual(self.execute()[0]['status'], 'duplicate')
        self.assertEqual(self.calls, [])

    def test_next_session_independent(self):
        self.execute()
        self.bar = '2026-10-09'
        result, code = self.execute(self.ctx('2026-10-12T19:00:00+08:00'))
        self.assertEqual(code, 0)
        self.assertEqual(result['latestDailyBar'], '2026-10-09')
        self.assertEqual(len(self.calls), 2)
        self.assertNotEqual(self.calls[0]['query_id'], self.calls[1]['query_id'])

    def test_stale_truthful_future_and_non_session_rejected(self):
        self.bar = '2026-10-07'
        self.assertEqual(self.execute()[0]['barFreshness'], 'stale')
        for date in ('2026-10-09', '2026-10-10', '2026-10-04'):
            ctx = self.ctx('2026-10-12T19:00:00+08:00')
            with sqlite3.connect(self.db) as conn:
                conn.execute('DELETE FROM analysis_history WHERE query_id=?', ('probe',))
                conn.execute('INSERT INTO analysis_history(query_id,code,raw_result,created_at) VALUES(?,?,?,?)', ('probe','QQQ',json.dumps({'market_snapshot':{'date':date},'model_used':'fixture/model'}),'2026-10-12 11:01:00'))
            if date == '2026-10-09':
                self.assertEqual(run.history(self.db,'probe',ctx,self.cal)['barFreshness'],'latest_complete')
            else:
                with self.assertRaises(run.Closed):
                    run.history(self.db,'probe',ctx,self.cal)

    def test_corrupt_and_spoofed_state(self):
        run.private_tree(self.receipt().parent)
        for text in ('not-json', '{}', json.dumps({'status':'success','attempt':0,'symbol':'SPY'})):
            self.receipt().write_text(text)
            with self.assertRaises(run.Closed):
                self.execute()
        self.assertEqual(self.calls, [])

    def test_symlink_paths_fail(self):
        target = Path(self.tmp.name) / 'outside'; target.mkdir()
        (self.state / 'scheduled-analysis').symlink_to(target, target_is_directory=True)
        with self.assertRaises(run.Closed):
            self.execute()
        self.assertEqual(list(target.iterdir()), [])

    def test_symlink_receipt_and_lock_fail(self):
        run.private_tree(self.receipt().parent)
        outside = Path(self.tmp.name) / 'outside'; outside.write_text('untouched')
        self.receipt().symlink_to(outside)
        with self.assertRaises(OSError):
            self.execute()
        self.receipt().unlink()
        (self.receipt().parent / '.lock').unlink()
        (self.receipt().parent / '.lock').symlink_to(outside)
        with self.assertRaises(OSError):
            self.execute()
        self.assertEqual(outside.read_text(), 'untouched')

    def test_permissions(self):
        self.execute()
        self.assertEqual(self.receipt().stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.receipt().parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.receipt().parent / '.lock').stat().st_mode & 0o777, 0o600)

    def test_crossprocess_slot_lock(self):
        directory = self.receipt().parent
        with run.slot_lock(directory) as owned:
            self.assertTrue(owned)
            script = 'from pathlib import Path;from scripts.scheduled_analysis import slot_lock;import sys;\nwith slot_lock(Path(sys.argv[1])) as owned: print(int(owned))'
            child = subprocess.run([sys.executable,'-c',script,str(directory)],cwd=run.ROOT,capture_output=True,text=True,timeout=10)
            self.assertEqual((child.returncode, child.stdout.strip()), (0,'0'))
        self.assertEqual(self.calls, [])

    def test_shared_model_lock_crossprocess(self):
        from src.llm.workbench_lock import shared_model_slot
        with patch.dict(os.environ, {'WORKBENCH_STATE_DIR':str(self.state)}):
            with shared_model_slot():
                child = subprocess.run([sys.executable,'-c','from src.llm.workbench_lock import shared_model_slot;\nwith shared_model_slot(): pass'],cwd=run.ROOT,capture_output=True,text=True,timeout=10)
                self.assertNotEqual(child.returncode,0)
            with shared_model_slot():
                pass

    def test_parser_no_clock_override(self):
        for args in (['--symbol','SPY'], ['--fake-date','2026-10-09'], ['--runtime-dir','/tmp/spoof'], ['--check','--self-test']):
            with self.assertRaises(SystemExit), patch('sys.stderr'):
                run.parser().parse_args(args)

    def test_check_read_only_next_slot(self):
        self.assertEqual(run.next_slot(datetime.fromisoformat('2026-10-09T03:19:00+00:00'),self.cal,self.name),'2026-10-09T19:00:00+08:00')
        self.assertFalse((self.state / 'scheduled-analysis').exists())
        self.assertEqual(self.calls, [])

    def test_public_launcher_environment_flags(self):
        from scripts.workbench import prepare_environment
        from types import SimpleNamespace
        # A fixture ROOT means no production watchlist/state/auth is touched.
        root = Path(self.tmp.name)
        binary = root / 'fixture-cli'; binary.write_text('# fixture'); binary.chmod(0o700)
        args = SimpleNamespace(runtime_dir=str(root/'runtime'),public_url='http://localhost',port=1,openclaw=str(binary),cli_home=str(root),agent='agenta',thinking='max',configured_target='display-only',model_timeout=600)
        with patch('scripts.workbench.ROOT',root):
            env,_ = prepare_environment(args, {'SECRET':'not-inherited'})
        for name in ('ADMIN_AUTH_ENABLED',):
            self.assertEqual(env[name],'true')
        for name in ('SCHEDULE_ENABLED','DAILY_MARKET_CONTEXT_ENABLED','ENABLE_REALTIME_QUOTE','AGENT_MODE'):
            self.assertEqual(env[name],'false')
        self.assertEqual(env['GENERATION_BACKEND_MAX_CONCURRENCY'],'1')
        self.assertEqual(env['OPENCLAW_THINKING'],'max')
        self.assertEqual(env['OPENCLAW_AGENT'],'agenta')
        self.assertNotIn('SECRET',env)
        self.assertFalse(list((root/'runtime').rglob('.admin_password_hash')))

    def test_process_boundary_no_prompt_output(self):
        proc = Path(self.tmp.name)/'proc'; proc.mkdir(); entry = proc/'123'; entry.mkdir()
        (entry/'cmdline').write_bytes(b'node\0official-cli\0gateway\0call\0agent\0--expect-final\0--params\0secretprompt\0')
        self.assertTrue(run.cli_busy(proc))
        (entry/'cmdline').write_bytes(b'other\0--params\0gateway\0call\0agent\0--expect-final\0')
        self.assertFalse(run.cli_busy(proc))

    def test_backend_slot_blocks_before_generate(self):
        from src.llm.workbench_lock import shared_model_slot
        from src.llm.openclaw_backend import OpenClawGenerationBackend
        from src.llm.generation_backend import GenerationError
        from types import SimpleNamespace
        backend = OpenClawGenerationBackend(SimpleNamespace())
        with patch.dict(os.environ, {'WORKBENCH_STATE_DIR':str(self.state)}):
            with shared_model_slot(), patch.object(backend, '_generate') as generate:
                with self.assertRaises(GenerationError):
                    backend.generate('fixture', {})
                generate.assert_not_called()
            with patch.object(backend, '_generate', return_value='fixture'):
                self.assertEqual(backend.generate('fixture', {}), 'fixture')

    def test_hardlink_state_refused(self):
        run.private_tree(self.receipt().parent)
        outside = Path(self.tmp.name)/'outside'; outside.write_text('{}')
        os.link(outside,self.receipt())
        with self.assertRaises(run.Closed):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_missing_history_fail_not_fake_success(self):
        class NoSave:
            def analyze_stock(self, **kw):
                return {'query_id':kw['query_id'],'stock_code':'QQQ'}
        result, code = run.execute(self.ctx(),self.cal,self.state,lambda:NoSave(),lambda:False)
        self.assertEqual((result['status'],code),('failed',1))
        self.assertEqual(result['category'],'history_identity_mismatch')

    def test_bar_future_same_session_refused(self):
        self.bar = '2026-10-09'
        result, code = self.execute()
        self.assertEqual((result['status'],code),('failed',1))
        self.assertEqual(result['category'],'invalid_saved_provenance')

    def test_naive_clock_refused(self):
        with self.assertRaises(run.Closed):
            run.context(datetime(2026,10,9,19),self.cal,self.name)

    def test_check_entry_never_prepares_or_reserves(self):
        import io
        output = io.StringIO()
        with patch.object(sys, 'argv', ['scheduled_analysis.py','--check']), patch.object(sys, 'stdout', output), patch.object(run,'production_service') as service, patch.object(run,'execute') as execute, patch.object(run,'safe_file') as files:
            self.assertEqual(run.main(),0)
        service.assert_not_called()
        execute.assert_not_called()
        files.assert_not_called()
        self.assertFalse(json.loads(output.getvalue())['productionReserved'])
