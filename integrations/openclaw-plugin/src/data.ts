import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface ReportView {
  id: number; code: string; name: string; createdAt: string;
  dataDate: string; actualModel: string; summary: string;
  newsStatus: string; quoteStatus: string; sourceViewStatus: string;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function parsed(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || Buffer.byteLength(value) > 1024 * 1024) return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}
function text(value: unknown, max = 8000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}
/** No schema migration, analysis service, network acquisition or configurable SQL. */
export class ReportData {
  constructor(readonly dbPath: string) {}
  latest(): ReportView[] {
    const stat = lstatSync(this.dbPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Report database is unavailable");
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1500;");
      const table = db.prepare("SELECT type FROM sqlite_master WHERE name='analysis_history'").get();
      if (table?.type !== "table") throw new Error("Expected original analysis_history table");
      const rows = db.prepare(`SELECT id,code,name,created_at,substr(analysis_summary,1,8000) AS analysis_summary,
        substr(raw_result,1,1048577) AS raw_result,substr(context_snapshot,1,1048577) AS context_snapshot
        FROM analysis_history WHERE code!='MARKET' AND coalesce(report_type,'')!='market_review'
        ORDER BY id DESC LIMIT 8`).all();
      return rows.map(row => {
        const raw = parsed(row.raw_result); const context = parsed(row.context_snapshot);
        const phase = object(context.market_phase_summary); const snapshot = object(raw.market_snapshot);
        const hasRaw = Object.keys(raw).length > 0;
        const actualModel = text(raw.model_used, 200);
        return {
          id: Number(row.id), code: text(row.code, 40), name: text(row.name, 100), createdAt: text(row.created_at, 64),
          dataDate: text(phase.effective_daily_bar_date, 32) || text(snapshot.date, 32) || "未记录",
          actualModel: actualModel || "未记录（不以配置目标代替）", summary: text(row.analysis_summary),
          newsStatus: "新闻尚未接入；本页不会搜索或生成新闻",
          quoteStatus: context.realtime_quote_raw ? "保存的行情快照；非实时刷新" : "实时行情缺失；Yahoo 日线并非实时行情",
          sourceViewStatus: !hasRaw ? "saved-report-metadata-unavailable" : actualModel ? "saved-report" : "saved-report-actual-model-unrecorded",
        };
      });
    } finally { db.close(); }
  }
}
