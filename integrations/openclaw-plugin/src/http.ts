import { constants, lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve, sep, extname } from "node:path";
import { OVERVIEW_CSS_TEXT } from "./resources.generated.js";
import type { DsaConfig } from "./config.js";
import { ReportData, type ReportView } from "./data.js";
import { APP_BASE, ROUTE_ROOT, RequestError, apiRoute, boundHeaders, canonicalUrl } from "./policy.js";
import { appSecurity, createDsaProxy, type ProxyTestOptions } from "./proxy.js";

const OVERVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const OVERVIEW_CSS = Buffer.from(OVERVIEW_CSS_TEXT, "utf8");
const SPA_ROUTES = new Set(["/", "/login", "/settings", "/chat", "/portfolio", "/decision-signals", "/screening", "/data", "/backtest", "/alerts", "/usage"]);
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2" };
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
function reportCard(report: ReportView): string {
  return `<article><h2>${escapeHtml(report.code)} · ${escapeHtml(report.name)} <small>#${report.id}</small></h2><dl>
    <dt>日线数据日期</dt><dd>${escapeHtml(report.dataDate)}</dd>
    <dt>实际模型（报告保存值）</dt><dd class="model">${escapeHtml(report.actualModel)}</dd>
    <dt>报告记录时间（原值）</dt><dd>${escapeHtml(report.createdAt)}</dd>
    <dt>来源视图状态</dt><dd>${escapeHtml(report.sourceViewStatus)}</dd></dl>
    <p class="notice">${escapeHtml(report.quoteStatus)}。${escapeHtml(report.newsStatus)}。</p>
    <h3>原报告摘要</h3><p class="summary">${escapeHtml(report.summary || "此报告未保存摘要")}</p></article>`;
}
export function overview(reports: ReportView[], unavailable = false): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>股票研究 · DSA</title><link rel="stylesheet" href="${ROUTE_ROOT}/overview.css"></head><body><main>
    <header><p class="eyebrow">OPENCLAW · DSA · 只读概览</p><h1>股票研究</h1><p>读取原 DSA 分析数据库；不会启动分析、新闻搜索、行情采集或模型调用。</p></header>
    <section class="entry"><h2>原版完整工作台</h2><p>侧栏内嵌页是安全只读视图。登录、手动分析与进度、自选股、历史和完整报告在同域顶层页面操作；仍须 DSA 自己的登录。</p>
    <a class="primary" href="${APP_BASE}/" target="_blank" rel="noopener noreferrer">打开完整工作台</a>
    <p>若 iframe 阻止弹窗：长按链接／右键在新标签页打开，或复制下方路径，加到当前域名后在地址栏打开。点击链接不保证浏览器已成功打开。</p>
    <label for="workbench-path">同域路径（不含 token，可选择后复制）</label><input id="workbench-path" value="${APP_BASE}/" readonly aria-label="完整工作台同域路径">
    </section>
    <section aria-label="保存的股票报告"><h2>最近保存的股票报告</h2>${unavailable ? '<p role="alert">报告数据库暂时不可读。未创建、迁移或修改数据库；请让 owner 核对配置。</p>' : reports.map(reportCard).join("") || '<p>暂无保存的股票报告。本页不会自动生成报告。</p>'}</section>
    <footer>实际模型不等同于当前配置目标。日线不是实时行情，新闻尚未接入；研究结论需人工核对，非交易建议。</footer>
    </main></body></html>`;
}
function send(res: ServerResponse, status: number, body: Buffer | string, type: string, head: boolean, app = false): void {
  if (app) appSecurity(res);
  else {
    res.setHeader("Content-Security-Policy", OVERVIEW_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
  }
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.statusCode = status; res.setHeader("Content-Type", type); res.setHeader("Content-Length", bytes.length); res.end(head ? undefined : bytes);
}
export async function staticAsset(staticDir: string, relative: string): Promise<Buffer> {
  const root = resolve(staticDir);
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new RequestError(503, "Gateway app bundle is unavailable");
  const parts = relative.split("/");
  if (!parts.length || parts.some(part => !part || part.startsWith(".") || !/^[A-Za-z0-9_\-.]+$/.test(part))) throw new RequestError(400, "Invalid asset path");
  let path = root;
  for (const [i, part] of parts.entries()) {
    path = join(path, part); const stat = lstatSync(path);
    if (stat.isSymbolicLink() || i < parts.length - 1 && !stat.isDirectory()) throw new RequestError(404, "Symlink assets are not served");
  }
  if (!path.startsWith(`${root}${sep}`) || realpathSync(path) !== path) throw new RequestError(404, "Asset escaped the admin root");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new RequestError(404, "Asset is not a bounded regular file");
    if (realpathSync(path) !== path || lstatSync(path).ino !== stat.ino) throw new RequestError(404, "Asset changed during open");
    return await handle.readFile();
  } finally { await handle.close(); }
}
export function createDsaHttpHandler(config: DsaConfig, options: ProxyTestOptions = {}) {
  const data = new ReportData(config.dbPath);
  const proxy = createDsaProxy(config, options);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const head = req.method === "HEAD";
    let isApp = false;
    try {
      boundHeaders(req);
      const url = canonicalUrl(req.url || "");
      isApp = url.pathname.startsWith(`${APP_BASE}/`) || url.pathname === APP_BASE;
      if (url.pathname === `${ROUTE_ROOT}/` || url.pathname === ROUTE_ROOT) {
        if (!["GET", "HEAD"].includes(req.method!)) throw new RequestError(405, "Sidebar is read-only");
        if (url.search) throw new RequestError(400, "Sidebar does not accept query parameters");
        let rows: ReportView[] = []; let unavailable = false;
        try { rows = data.latest(); } catch { unavailable = true; }
        send(res, unavailable ? 503 : 200, overview(rows, unavailable), "text/html; charset=utf-8", head); return true;
      }
      if (url.pathname === `${ROUTE_ROOT}/overview.css`) {
        if (!["GET", "HEAD"].includes(req.method!) || url.search) throw new RequestError(405, "Asset is read-only");
        send(res, 200, OVERVIEW_CSS, "text/css; charset=utf-8", head); return true;
      }
      if (!isApp) throw new RequestError(404, "Route not found");
      if (url.pathname.startsWith(`${APP_BASE}/api/`)) {
        const route = apiRoute(url, req.method!);
        await proxy(req, res, route, url.search); return true;
      }
      if (!["GET", "HEAD"].includes(req.method!)) throw new RequestError(405, "Assets are read-only");
      if (url.pathname === APP_BASE) {
        if (url.search) throw new RequestError(400, "Unexpected app query");
        appSecurity(res); res.statusCode = 308; res.setHeader("Location", `${APP_BASE}/`); res.setHeader("Content-Length", "0"); res.end(); return true;
      }
      const suffix = url.pathname.slice(APP_BASE.length);
      const spa = SPA_ROUTES.has(suffix.replace(/\/$/, "") || "/");
      const relative = spa ? "index.html" : suffix.slice(1);
      const type = TYPES[extname(relative)];
      if (!type || type.startsWith("text/html") && relative !== "index.html") throw new RequestError(404, "Unknown asset type");
      if (url.search && !spa && !(relative === "stocks.index.json" && /^\?_t=\d{1,12}$/.test(url.search))) throw new RequestError(400, "Unexpected asset query");
      const asset = await staticAsset(config.staticDir, relative);
      if (relative === "index.html" && !asset.toString("utf8").includes(`${APP_BASE}/assets/`)) throw new RequestError(503, "Build the original app with the matching Gateway prefix first");
      send(res, 200, asset, type, head, true); return true;
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      const status = error instanceof RequestError ? error.status : (error as NodeJS.ErrnoException)?.code === "ENOENT" ? 404 : 503;
      if (status === 405) res.setHeader("Allow", isApp ? "GET, HEAD, POST (allowlisted API only)" : "GET, HEAD");
      send(res, status, JSON.stringify({ error: "dsa_workbench_request_rejected", message: error instanceof RequestError ? error.message : "DSA resource unavailable" }), "application/json; charset=utf-8", head, isApp);
      return true;
    }
  };
}
export { OVERVIEW_CSP };
