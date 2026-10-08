import { useEffect, useState } from 'react';
import apiClient from '../../api';
import { MANUAL_WORKBENCH } from '../../utils/workbench';

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
    <strong>私人手动研究工作台</strong> · 一次一只美股 · 无通知／文档外发／交易／定时任务<br />
    配置目标：{target} · thinking：{thinking}；实际模型以每份报告标注为准。<br />
    Yahoo 日线并非实时行情；新闻尚未接入。数据日期见报告，研究结果需人工核对，不构成交易建议。
  </div>;
}

export function WorkbenchDisabledPage() {
  return <div className="rounded-xl border border-border bg-card p-6">
    <h1 className="text-lg font-semibold">此功能在私人手动模式下已禁用</h1>
    <p className="mt-3 text-sm text-secondary-text">首版只开放自选股、单股手动分析与进度、历史／详细报告。配置、Agent、通知、调度、回测、持仓、自动筛选及导入不会被执行；服务端也拒绝这些操作。</p>
  </div>;
}
