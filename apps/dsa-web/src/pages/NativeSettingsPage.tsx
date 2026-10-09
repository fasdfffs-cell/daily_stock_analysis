import { useCallback, useEffect, useState } from 'react';
import apiClient from '../api';
import { getParsedApiError } from '../api/error';
import { Card } from '../components/common';

type NativeStatus = { registered: boolean; enabled: boolean; running: boolean; timezone: string;
  scheduled_stocks: string[]; next_eligible_at: string | null; last_run_at: string | null;
  last_success_at: string | null; last_error: string | null; calendar_error: string | null };

export default function NativeSettingsPage() {
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState('19:00');
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState<NativeStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [config, health] = await Promise.all([
      apiClient.get('/api/v1/system/config'), apiClient.get('/api/v1/system/scheduler/status'),
    ]);
    const values = Object.fromEntries(config.data.items.map((i: { key: string; value: string }) => [i.key, i.value]));
    setVersion(config.data.config_version);
    setEnabled(values.SCHEDULE_ENABLED === 'true'); setTime(values.SCHEDULE_TIME);
    setStatus(health.data);
  }, []);
  useEffect(() => { void load().catch(err => setMessage(getParsedApiError(err).message)); }, [load]);
  return <Card className="space-y-4 p-5">
    <h1 className="text-xl font-semibold">原生定时设置</h1>
    <p>定时股票：QQQ（当前授权范围固定，只读，不影响普通自选）。时区：Asia/Shanghai。</p>
    <p className="text-sm text-secondary-text">美股交易日；交易所日历异常停止生成。19:00 上海是纽约盘前，不是当晚收盘数据。不开机补跑、不在启动时立即生成、不发送通知。后端必须持续运行。</p>
    <form className="space-y-4" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setMessage('');
      try {
        await apiClient.put('/api/v1/system/config', { config_version: version, reload_now: true,
          items: [{ key: 'SCHEDULE_ENABLED', value: String(enabled) }, { key: 'SCHEDULE_TIME', value: time }] });
        await load(); setMessage('已保存并重建原生定时；未立即生成报告。');
      } catch (err) { setMessage(getParsedApiError(err).message); }
      finally { setBusy(false); }
    }}>
      <label className="block"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> 启用原生定时（切换前须停用旧外部排程）</label>
      <label className="block">执行时间（HH:MM） <input aria-label="执行时间" className="input" type="time" required value={time} onChange={e => setTime(e.target.value)} /></label>
      <button className="btn-primary" type="submit" disabled={busy || !version || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)}>保存定时设置</button>
    </form>
    <button className="btn-secondary" onClick={() => void load().catch(err => setMessage(getParsedApiError(err).message))}>刷新真实运行状态</button>
    {message && <p role="status">{message}</p>}
    {status && <dl className="space-y-2 text-sm" aria-label="原生运行状态">
      <dt>注册 / 启用 / 运行中</dt><dd>{String(status.registered)} / {String(status.enabled)} / {String(status.running)}</dd>
      <dt>下次实际交易日时刻</dt><dd>{status.next_eligible_at || (status.enabled ? '不可用' : '已停用，不排程')}</dd>
      <dt>最后运行 / 成功</dt><dd>{status.last_run_at || '尚未运行'} / {status.last_success_at || '尚无成功运行'}</dd>
      <dt>最近失败 / 日历状态</dt><dd>{status.last_error || '无已记录失败'} / {status.calendar_error || '无已记录日历错误'}</dd>
    </dl>}
    <p className="text-sm">手工持仓仅本地账本／已保存价格，不接券商、不自动报价；缺失估值会明确标注。回测仅评估已保存报告与日线，缺数据不联网补齐。用量未接入，不假报为零。</p>
  </Card>;
}
