import { useEffect, useState } from 'react';
import apiClient from '../../api';
import { MANUAL_WORKBENCH, NATIVE_RESEARCH } from '../../utils/workbench';

export function WorkbenchNotice() {
  const [target, setTarget] = useState('读取中');
  const [thinking, setThinking] = useState('');
  useEffect(() => {
    if (!MANUAL_WORKBENCH) return;
    let active = true;
    apiClient.get('/api/v1/workbench/status').then(({ data }) => {
      if (active) {
        setTarget(data.configured_target || '继承 Agent 默认');
        setThinking(data.thinking || 'inherited');
      }
    }).catch(() => { if (active) setTarget('状态读取失败'); });
    return () => { active = false; };
  }, []);
  if (!MANUAL_WORKBENCH) return null;
  return <div className="mb-3 rounded-xl border border-border bg-card px-4 py-3 text-xs leading-6" role="status">
    <strong>{NATIVE_RESEARCH ? '私人研究工作台 · 原生定时' : '私人手动研究工作台'}</strong> · 一次一只美股 · 无通知／文档外发／真实交易{!NATIVE_RESEARCH && '／定时任务'}<br />
    配置目标：{target} · thinking：{thinking}；实际模型以每份报告标注为准。<br />
    Yahoo 日线并非实时行情；新闻尚未接入。数据日期见报告，研究结果需人工核对，不构成交易建议。
  </div>;
}

export function WorkbenchDisabledPage() {
  return <div className="rounded-xl border border-border bg-card p-6">
    <h1 className="text-lg font-semibold">此功能在私人研究模式下未开放</h1>
    <p className="mt-3 text-sm text-secondary-text">{NATIVE_RESEARCH ? '仅开放自选、串行单股研究、历史、原生定时设置、手工持仓账本与本地历史回测。问股、Agent、选股、新闻、主动提醒、CSV导入及真实交易未开放；服务端同样拒绝。' : '手动模式仅开放自选、单股分析、历史报告；其他功能未开放。'}</p>
  </div>;
}
