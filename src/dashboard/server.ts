/**
 * SNS 投稿ダッシュボードサーバー
 *
 * 使い方:
 *   npm run dashboard
 *   ブラウザで http://localhost:3001 を開く
 */
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import https from 'https';

const app = express();
const PORT = parseInt(process.env['DASHBOARD_PORT'] ?? '3001', 10);
const GH_REPO = 'YOUR_GITHUB_USERNAME/YOUR_REPO';
const GH_TOKEN = process.env['GITHUB_TOKEN'] ?? '';

app.use(express.json());

const DATA_DIR = path.join(process.cwd(), 'data');
const ANALYTICS_FILE = path.join(DATA_DIR, 'x-analytics.jsonl');
const SLOT_SUMMARY_FILE = path.join(DATA_DIR, 'x-slot-summary.jsonl');
const STRATEGY_FILE = path.join(DATA_DIR, 'strategy.json');
const AFFILIATE_PRODUCTS_FILE = path.join(DATA_DIR, 'affiliate-products.json');
const AFFILIATE_LOG_FILE = path.join(DATA_DIR, 'affiliate-post-log.jsonl');
const MANUAL_KPI_FILE = path.join(DATA_DIR, 'manual-kpi.jsonl');

// ── ユーティリティ ──────────────────────────────────────────

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) as T; } catch { return null; } })
    .filter((r): r is T => r !== null);
}

function toJST(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function last7Days(): string[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return d.toISOString().slice(0, 10);
  });
}

function last14Days(): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });
}

function todayJST(): string {
  return toJST(new Date().toISOString());
}

function fetchGitHub(endpoint: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: endpoint,
      headers: {
        'User-Agent': 'chatwork-x-dashboard/1.0',
        'Accept': 'application/vnd.github+json',
        ...(GH_TOKEN ? { 'Authorization': `Bearer ${GH_TOKEN}` } : {}),
      },
    };
    https.get(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

// ── 型定義 ──────────────────────────────────────────────────

interface AnalyticsRecord {
  postedAt: string; slot: string; platform?: string; theme: string;
  source: string; url: string; title: string; success: boolean;
  contentLength?: number;
}
interface SlotRunSummary {
  type: 'slot_summary'; date: string; executedAt: string; slot: string;
  totalMessages: number; opinionSkipped: number; cacheSkipped: number;
  qualityCandidates: number; batchSize: number; succeeded: number;
  errored: number; categoriesUsed: string[]; dryRun: boolean;
}
interface GhRun {
  id: number; name: string; status: string; conclusion: string | null;
  created_at: string; html_url: string; inputs?: Record<string, string>;
}
interface AffiliatePostLog {
  postedAt: string; platform: string;
  products: { rank: number; id: string; name: string; price?: number; affiliateUrl: string }[];
  rankingTitle: string; success: boolean; dryRun: boolean;
}
interface ManualKpi {
  date: string; platform: string;
  imp?: number; pv?: number; clicks?: number; revenue?: number; note?: string;
}

// ── API ──────────────────────────────────────────────────────

// 投稿統計
app.get('/api/stats', (_req, res) => {
  const records = readJsonl<AnalyticsRecord>(ANALYTICS_FILE);
  const days = last7Days();
  const today = todayJST();
  const platforms = ['x', 'instagram', 'tiktok', 'note'];

  const daily: Record<string, Record<string, number>> = {};
  for (const d of days) {
    daily[d] = Object.fromEntries(platforms.map(p => [p, 0]));
    daily[d]['total'] = 0;
  }
  for (const r of records) {
    if (!r.success) continue;
    const day = toJST(r.postedAt);
    if (!daily[day]) continue;
    const plat = r.platform ?? 'x';
    daily[day][plat] = (daily[day][plat] ?? 0) + 1;
    daily[day]['total'] = (daily[day]['total'] ?? 0) + 1;
  }

  const todayRecs = records.filter(r => toJST(r.postedAt) === today && r.success);
  const bySlot: Record<string, number> = {};
  for (const r of todayRecs.filter(r => (r.platform ?? 'x') === 'x')) {
    bySlot[r.slot] = (bySlot[r.slot] ?? 0) + 1;
  }
  const byTheme: Record<string, number> = {};
  for (const r of todayRecs.filter(r => (r.platform ?? 'x') === 'x')) {
    byTheme[r.theme] = (byTheme[r.theme] ?? 0) + 1;
  }
  const bySource: Record<string, number> = {};
  for (const r of todayRecs) {
    const src = r.source === 'chatwork' ? 'Chatwork' : 'RSS';
    bySource[src] = (bySource[src] ?? 0) + 1;
  }

  const todayTotal = todayRecs.length;
  const kpiTarget = 15;
  const todayAll = records.filter(r => toJST(r.postedAt) === today);
  const errorRate = todayAll.length > 0
    ? Math.round((todayAll.filter(r => !r.success).length / todayAll.length) * 100) : 0;

  const recent = records.slice(-15).reverse().map(r => ({
    title: r.title?.slice(0, 50) ?? '', slot: r.slot, platform: r.platform ?? 'x',
    theme: r.theme, postedAt: r.postedAt, success: r.success,
  }));

  const platformSummary = Object.fromEntries(platforms.map(p => {
    const pRecs = todayRecs.filter(r => (r.platform ?? 'x') === p);
    return [p, { count: pRecs.length, sources: [...new Set(pRecs.map(r => r.source))].length }];
  }));

  const weeklyKpi = days.map(d => ({
    date: d, count: daily[d]?.['total'] ?? 0,
    achieved: (daily[d]?.['total'] ?? 0) >= kpiTarget,
  }));

  res.json({ today, kpi: { target: kpiTarget, actual: todayTotal, errorRate }, daily, days, bySlot, byTheme, bySource, recent, platformSummary, weeklyKpi });
});

// スロット実行
app.get('/api/slots', (_req, res) => {
  const today = todayJST();
  const all = readJsonl<SlotRunSummary>(SLOT_SUMMARY_FILE);
  res.json({ today: all.filter(s => s.date === today), history: all.slice(-35) });
});

// 戦略
app.get('/api/strategy', (_req, res) => {
  if (!fs.existsSync(STRATEGY_FILE)) { res.json({ exists: false }); return; }
  try { res.json({ exists: true, strategy: JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf-8')) }); }
  catch { res.json({ exists: false }); }
});

// GitHub Actions — 全ワークフロー
const WORKFLOWS = [
  { id: 'x-daily-transfer.yml',      label: 'X 投稿' },
  { id: 'forte-daily-transfer.yml',  label: 'Forte.AI 転送' },
  { id: 'forte-to-sns.yml',          label: 'Forte→SNS' },
  { id: 'pdca-cycle.yml',            label: 'PDCA 分析' },
];

app.get('/api/all-actions', async (_req, res) => {
  try {
    const results = await Promise.all(WORKFLOWS.map(async wf => {
      const data = await fetchGitHub(
        `/repos/${GH_REPO}/actions/workflows/${wf.id}/runs?per_page=5`
      ) as { workflow_runs?: GhRun[] } | null;
      const runs = data?.workflow_runs ?? [];
      return { ...wf, runs: runs.slice(0, 3) };
    }));
    res.json({ workflows: results });
  } catch {
    res.json({ workflows: WORKFLOWS.map(wf => ({ ...wf, runs: [] })) });
  }
});

// アフィリエイト
app.get('/api/affiliate', (_req, res) => {
  let products: Record<string, unknown>[] = [];
  if (fs.existsSync(AFFILIATE_PRODUCTS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(AFFILIATE_PRODUCTS_FILE, 'utf-8'));
      products = data.products ?? [];
    } catch { /* ignore */ }
  }
  const logs = readJsonl<AffiliatePostLog>(AFFILIATE_LOG_FILE);
  const recentPosts = logs.slice(-30).reverse();
  res.json({ products, recentPosts, totalPosts: logs.length });
});

// 手動 Imp/PV — 読み込み
app.get('/api/kpi-manual', (_req, res) => {
  const entries = readJsonl<ManualKpi>(MANUAL_KPI_FILE);
  res.json({ entries: entries.slice(-90) }); // 直近 90件（約3ヶ月）
});

// 手動 Imp/PV — 保存
app.post('/api/kpi-manual', (req, res) => {
  const body = req.body as ManualKpi;
  if (!body.date || !body.platform) {
    res.status(400).json({ error: 'date と platform は必須です' }); return;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(MANUAL_KPI_FILE, JSON.stringify({ ...body, savedAt: new Date().toISOString() }) + '\n', 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── HTML ────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SNS ダッシュボード | @twisokhou</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0f1e;color:#e2e8f0;min-height:100vh}
.header{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);border-bottom:1px solid #1e3a5f;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
.header-left{display:flex;align-items:center;gap:12px}
.header-logo{font-size:1.5rem}
.header-title{font-size:1.15rem;font-weight:800;color:#f8fafc}
.header-sub{font-size:.75rem;color:#7c8db5;margin-top:1px}
.header-right{display:flex;align-items:center;gap:10px}
.clock{font-size:.82rem;color:#64748b;font-variant-numeric:tabular-nums}
.btn{background:#1e293b;border:1px solid #334155;color:#94a3b8;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:.78rem;transition:all .15s}
.btn:hover{background:#334155;color:#f8fafc}
.btn-primary{background:#1d4ed8;border-color:#2563eb;color:#fff}
.btn-primary:hover{background:#2563eb}
.nav{display:flex;gap:2px;padding:12px 24px 0;background:#0a0f1e;border-bottom:1px solid #1e293b;overflow-x:auto}
.tab{padding:8px 14px;border-radius:8px 8px 0 0;cursor:pointer;font-size:.78rem;font-weight:600;color:#475569;transition:all .15s;border:1px solid transparent;border-bottom:none;display:flex;align-items:center;gap:5px;white-space:nowrap}
.tab:hover{color:#94a3b8;background:#111827}
.tab.active{color:#f8fafc;background:#0f172a;border-color:#1e293b}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.main{padding:18px 24px;max-width:1440px}
.section-title{font-size:.75rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.section-title::after{content:'';flex:1;height:1px;background:#1e293b}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}
.kpi-card{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:14px 16px;position:relative;overflow:hidden}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;border-radius:10px 10px 0 0}
.kpi-card.ok::before{background:#22c55e}
.kpi-card.warn::before{background:#f59e0b}
.kpi-card.err::before{background:#ef4444}
.kpi-card.neu::before{background:#3b82f6}
.kpi-card.purple::before{background:#a78bfa}
.kpi-label{font-size:.7rem;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.kpi-value{font-size:2rem;font-weight:800;line-height:1}
.kpi-value.ok{color:#22c55e}.kpi-value.warn{color:#f59e0b}.kpi-value.err{color:#ef4444}.kpi-value.neu{color:#60a5fa}.kpi-value.purple{color:#a78bfa}
.kpi-sub{font-size:.7rem;color:#334155;margin-top:5px}
.progress-bar{height:4px;background:#1e293b;border-radius:2px;margin-top:8px;overflow:hidden}
.progress-fill{height:100%;border-radius:2px;transition:width .5s ease}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px}
@media(max-width:1100px){.grid3{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.grid2,.grid3{grid-template-columns:1fr}}
.card{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:14px 16px}
.card-title{font-size:.75rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
.chart-wrap{position:relative;height:200px}
.chart-wrap-sm{position:relative;height:150px}
.run-list{display:flex;flex-direction:column;gap:5px}
.run-item{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#0a0f1e;border:1px solid #1e293b;border-radius:8px;font-size:.78rem}
.run-status{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.run-status.success{background:#22c55e;box-shadow:0 0 6px #22c55e88}
.run-status.failure{background:#ef4444;box-shadow:0 0 6px #ef444488}
.run-status.in_progress{background:#f59e0b;animation:pulse 1.5s infinite}
.run-status.queued{background:#64748b}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.run-wf{font-size:.68rem;color:#475569;width:80px;flex-shrink:0}
.run-name{flex:1;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run-time{font-size:.68rem;color:#334155;white-space:nowrap}
.run-link{font-size:.68rem;color:#3b82f6;text-decoration:none}
.run-badge{font-size:.62rem;padding:1px 5px;border-radius:3px;font-weight:700;white-space:nowrap}
.run-badge.success{background:#22c55e22;color:#22c55e}
.run-badge.failure{background:#ef444422;color:#ef4444}
.run-badge.in_progress{background:#f59e0b22;color:#f59e0b}
.run-badge.queued{background:#64748b22;color:#64748b}
.slot-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
@media(max-width:900px){.slot-grid{grid-template-columns:1fr 1fr}}
.slot-card{background:#0a0f1e;border:1px solid #1e293b;border-radius:8px;padding:10px 12px}
.slot-card.done{border-color:#166534}
.slot-name{font-size:.7rem;font-weight:700;color:#475569;margin-bottom:4px}
.slot-name.done{color:#22c55e}
.slot-count{font-size:1.4rem;font-weight:800;color:#f8fafc;line-height:1}
.slot-detail{font-size:.63rem;color:#334155;margin-top:3px}
.platform-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
@media(max-width:700px){.platform-row{grid-template-columns:1fr 1fr}}
.pf-card{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:10px}
.pf-icon{width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0}
.pf-name{font-size:.7rem;font-weight:700;color:#475569}
.pf-count{font-size:1.4rem;font-weight:800;line-height:1.1}
.pf-sub{font-size:.63rem;color:#334155}
.weekly-kpi{display:flex;gap:6px;align-items:flex-end;height:60px}
.wk-bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;height:100%}
.wk-bar{width:100%;border-radius:4px 4px 0 0;min-height:3px}
.wk-bar.achieved{background:linear-gradient(180deg,#22c55e,#16a34a)}
.wk-bar.partial{background:linear-gradient(180deg,#f59e0b,#d97706)}
.wk-bar.empty{background:#1e293b}
.wk-label{font-size:.57rem;color:#334155}
.wk-count{font-size:.6rem;color:#64748b}
.recent-list{list-style:none;display:flex;flex-direction:column;gap:0}
.recent-item{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #0f1929;font-size:.78rem}
.recent-item:last-child{border-bottom:none}
.badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:.62rem;font-weight:700;white-space:nowrap}
.badge-x{background:#1d9bf020;color:#1d9bf0}
.badge-instagram{background:#e1306c20;color:#e1306c}
.badge-tiktok{background:#69c9d020;color:#69c9d0}
.badge-note{background:#41c9b420;color:#41c9b4}
.badge-affiliate{background:#a78bfa20;color:#a78bfa}
.badge-ok{background:#22c55e20;color:#22c55e}
.badge-err{background:#ef444420;color:#ef4444}
.title-text{flex:1;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ts{font-size:.67rem;color:#334155;white-space:nowrap}
.strategy-wrap{display:flex;flex-direction:column;gap:7px}
.strategy-item{display:flex;align-items:center;gap:10px}
.strategy-label{font-size:.76rem;color:#94a3b8;width:110px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.strategy-bar-wrap{flex:1;height:6px;background:#1e293b;border-radius:3px;overflow:hidden}
.strategy-bar{height:100%;border-radius:3px;background:linear-gradient(90deg,#3b82f6,#8b5cf6)}
.strategy-pct{font-size:.7rem;color:#475569;width:34px;text-align:right}
/* アフィリ */
.prod-grid{display:flex;flex-direction:column;gap:8px}
.prod-card{background:#0a0f1e;border:1px solid #1e293b;border-radius:8px;padding:12px 14px;display:flex;align-items:center;gap:12px}
.prod-rank{font-size:1.6rem;flex-shrink:0;width:36px;text-align:center}
.prod-info{flex:1;min-width:0}
.prod-name{font-size:.85rem;font-weight:700;color:#f8fafc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prod-meta{font-size:.7rem;color:#475569;margin-top:2px}
.prod-price{font-size:.78rem;color:#a78bfa;font-weight:700}
.prod-link{font-size:.7rem;color:#3b82f6;text-decoration:none;white-space:nowrap}
.prod-link:hover{text-decoration:underline}
.affiliate-log{list-style:none;display:flex;flex-direction:column;gap:5px}
.aff-item{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:#0a0f1e;border:1px solid #1e293b;border-radius:7px;font-size:.78rem}
.aff-names{flex:1;color:#94a3b8;font-size:.75rem}
/* Imp/PV フォーム */
.form-card{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:16px}
.form-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:12px}
.form-group{display:flex;flex-direction:column;gap:4px}
.form-label{font-size:.7rem;color:#475569;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.form-input{background:#0a0f1e;border:1px solid #334155;color:#e2e8f0;padding:7px 10px;border-radius:6px;font-size:.82rem;outline:none}
.form-input:focus{border-color:#3b82f6}
.form-select{background:#0a0f1e;border:1px solid #334155;color:#e2e8f0;padding:7px 10px;border-radius:6px;font-size:.82rem;outline:none}
.form-btn{background:#1d4ed8;border:none;color:#fff;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:.82rem;font-weight:600;transition:background .15s}
.form-btn:hover{background:#2563eb}
.form-msg{font-size:.75rem;margin-top:8px;min-height:18px}
.form-msg.ok{color:#22c55e}.form-msg.err{color:#ef4444}
.tab-content{display:none}
.tab-content.active{display:block}
.loading{display:flex;align-items:center;justify-content:center;height:60px;color:#334155;font-size:.8rem}
.spinner{width:13px;height:13px;border:2px solid #1e293b;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite;margin-right:7px}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:20px;color:#334155;font-size:.8rem}
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <div class="header-logo">🕊️</div>
    <div>
      <div class="header-title">SNS 投稿ダッシュボード</div>
      <div class="header-sub">@twisokhou — 世界のトレンド報道局</div>
    </div>
  </div>
  <div class="header-right">
    <div class="clock" id="clock"></div>
    <button class="btn" onclick="loadAll()">↻ 更新</button>
    <a class="btn btn-primary" href="https://github.com/${GH_REPO}/actions" target="_blank">Actions ↗</a>
  </div>
</div>

<div class="nav">
  <div class="tab active" onclick="switchTab('today')"><span class="dot" style="background:#a78bfa"></span>本日</div>
  <div class="tab" onclick="switchTab('weekly')"><span class="dot" style="background:#22c55e"></span>週間</div>
  <div class="tab" onclick="switchTab('actions')"><span class="dot" style="background:#f59e0b"></span>Actions</div>
  <div class="tab" onclick="switchTab('affiliate')"><span class="dot" style="background:#a78bfa"></span>アフィリ</div>
  <div class="tab" onclick="switchTab('kpi')"><span class="dot" style="background:#38bdf8"></span>Imp/PV</div>
  <div class="tab" onclick="switchTab('pdca')"><span class="dot" style="background:#fb923c"></span>PDCA</div>
</div>

<div class="main">

  <!-- 本日 -->
  <div class="tab-content active" id="tab-today">
    <div class="section-title">KPI — 本日</div>
    <div class="kpi-row" id="kpi-today"></div>
    <div class="section-title">プラットフォーム別</div>
    <div class="platform-row" id="platform-row-today"></div>
    <div class="section-title">スロット実行</div>
    <div class="card" style="margin-bottom:12px"><div class="slot-grid" id="slot-panel"></div></div>
    <div class="grid2">
      <div class="card">
        <div class="card-title">直近の投稿</div>
        <ul class="recent-list" id="recent-list"></ul>
      </div>
      <div class="card">
        <div class="card-title">本日 テーマ分布 (X)</div>
        <div class="chart-wrap"><canvas id="themeChart"></canvas></div>
      </div>
    </div>
  </div>

  <!-- 週間 -->
  <div class="tab-content" id="tab-weekly">
    <div class="section-title">7日間 投稿推移（プラットフォーム別）</div>
    <div class="card" style="margin-bottom:12px"><div class="chart-wrap"><canvas id="trendChart"></canvas></div></div>
    <div class="section-title">KPI 達成状況（直近7日・目標 20件/日）</div>
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:.72rem;color:#475569">目標: 20件/日（全プラットフォーム合計）</span>
        <span style="font-size:.72rem;color:#475569" id="kpi-achieve-rate"></span>
      </div>
      <div class="weekly-kpi" id="weekly-kpi-bars"></div>
    </div>
    <div class="grid2">
      <div class="card">
        <div class="card-title">ソース別（本日）</div>
        <div class="chart-wrap-sm"><canvas id="sourceChart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">X スロット別（本日）</div>
        <div class="chart-wrap-sm"><canvas id="xSlotChart"></canvas></div>
      </div>
    </div>
  </div>

  <!-- Actions -->
  <div class="tab-content" id="tab-actions">
    <div class="section-title">GitHub Actions — 全ワークフロー</div>
    <div id="actions-all" class="card"><div class="loading"><div class="spinner"></div>読み込み中...</div></div>
  </div>

  <!-- アフィリ -->
  <div class="tab-content" id="tab-affiliate">
    <div class="section-title">現在のランキング商品</div>
    <div class="card" style="margin-bottom:12px" id="affiliate-products">
      <div class="loading"><div class="spinner"></div>読み込み中...</div>
    </div>
    <div class="section-title">投稿履歴</div>
    <div class="card" id="affiliate-log">
      <div class="loading"><div class="spinner"></div>読み込み中...</div>
    </div>
  </div>

  <!-- Imp/PV -->
  <div class="tab-content" id="tab-kpi">
    <div class="section-title">数値を手動入力（各プラットフォームのアナリティクスから）</div>
    <div class="form-card" style="margin-bottom:14px">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">日付</label>
          <input class="form-input" type="date" id="kpi-date">
        </div>
        <div class="form-group">
          <label class="form-label">プラットフォーム</label>
          <select class="form-select" id="kpi-platform">
            <option value="x">X</option>
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
            <option value="note">note</option>
            <option value="forte">Forte.AI</option>
            <option value="affiliate">アフィリ</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">インプレッション</label>
          <input class="form-input" type="number" id="kpi-imp" placeholder="例: 12000">
        </div>
        <div class="form-group">
          <label class="form-label">PV / 再生数</label>
          <input class="form-input" type="number" id="kpi-pv" placeholder="例: 3000">
        </div>
        <div class="form-group">
          <label class="form-label">クリック数</label>
          <input class="form-input" type="number" id="kpi-clicks" placeholder="例: 250">
        </div>
        <div class="form-group">
          <label class="form-label">収益 (円)</label>
          <input class="form-input" type="number" id="kpi-revenue" placeholder="例: 1500">
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">メモ</label>
          <input class="form-input" id="kpi-note" placeholder="任意メモ">
        </div>
      </div>
      <button class="form-btn" onclick="saveKpi()">保存</button>
      <div class="form-msg" id="kpi-msg"></div>
    </div>

    <div class="section-title">トレンド（直近14日）</div>
    <div class="grid2" style="margin-bottom:12px">
      <div class="card">
        <div class="card-title">インプレッション推移</div>
        <div class="chart-wrap"><canvas id="impChart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">PV / 再生数推移</div>
        <div class="chart-wrap"><canvas id="pvChart"></canvas></div>
      </div>
    </div>
    <div class="grid2" style="margin-bottom:12px">
      <div class="card">
        <div class="card-title">クリック数推移</div>
        <div class="chart-wrap-sm"><canvas id="clickChart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">収益（円）推移</div>
        <div class="chart-wrap-sm"><canvas id="revenueChart"></canvas></div>
      </div>
    </div>

    <div class="section-title">履歴</div>
    <div class="card" id="kpi-history"></div>
  </div>

  <!-- PDCA -->
  <div class="tab-content" id="tab-pdca">
    <div class="section-title">現在の投稿戦略</div>
    <div class="grid2" style="margin-bottom:12px">
      <div class="card" id="strategy-panel"><div class="loading"><div class="spinner"></div>読み込み中...</div></div>
      <div class="card">
        <div class="card-title">7日間 スロット集計</div>
        <div class="chart-wrap"><canvas id="pdcaSlotChart"></canvas></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">スロット実行履歴（直近35件）</div>
      <div class="chart-wrap"><canvas id="slotHistChart"></canvas></div>
    </div>
  </div>

</div>

<script>
const charts = {};
const COLORS = { x:'#1d9bf0', instagram:'#e1306c', tiktok:'#69c9d0', note:'#41c9b4', forte:'#a78bfa', affiliate:'#fb923c' };
const SLOT_LABELS = { slot07:'07:30 通勤', slot11:'11:00 午前', slot12:'12:00 昼', slot14:'14:00 午後', slot17:'17:00 夕方' };
const SLOTS = ['slot07','slot11','slot12','slot14','slot17'];
let gStats=null, gSlots=null, gStrategy=null, gActions=null, gAffiliate=null, gKpi=null;
let activeTab = 'today';

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((t,i) => {
    const names = ['today','weekly','actions','affiliate','kpi','pdca'];
    t.classList.toggle('active', names[i] === name);
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  renderTab(name);
}

async function loadAll() {
  await Promise.all([
    fetch('/api/stats').then(r=>r.json()).then(d=>{ gStats=d; }),
    fetch('/api/slots').then(r=>r.json()).then(d=>{ gSlots=d; }),
    fetch('/api/strategy').then(r=>r.json()).then(d=>{ gStrategy=d; }),
    fetch('/api/all-actions').then(r=>r.json()).then(d=>{ gActions=d; }),
    fetch('/api/affiliate').then(r=>r.json()).then(d=>{ gAffiliate=d; }),
    fetch('/api/kpi-manual').then(r=>r.json()).then(d=>{ gKpi=d; }),
  ]);
  renderTab(activeTab);
}

function renderTab(tab) {
  if (!gStats) return;
  if (tab==='today') renderToday();
  if (tab==='weekly') renderWeekly();
  if (tab==='actions') renderActions();
  if (tab==='affiliate') renderAffiliate();
  if (tab==='kpi') renderKpi();
  if (tab==='pdca') renderPdca();
}

// ── 本日 ──
function renderToday() {
  const d = gStats;
  const cl = d.kpi.actual>=d.kpi.target?'ok':d.kpi.actual>=d.kpi.target*.7?'warn':'err';
  const pct = Math.min(100,Math.round(d.kpi.actual/d.kpi.target*100));
  document.getElementById('kpi-today').innerHTML =
    kpiCard('本日投稿数',d.kpi.actual,'目標: '+d.kpi.target+'件',cl,pct)+
    kpiCard('エラー率',d.kpi.errorRate+'%','目標: <5%',d.kpi.errorRate===0?'ok':d.kpi.errorRate<10?'warn':'err')+
    kpiCard('X',d.platformSummary.x?.count??0,'本日','neu')+
    kpiCard('Instagram',d.platformSummary.instagram?.count??0,'本日','neu')+
    kpiCard('TikTok',d.platformSummary.tiktok?.count??0,'本日','neu')+
    kpiCard('note',d.platformSummary.note?.count??0,'本日','neu');

  document.getElementById('platform-row-today').innerHTML = ['x','instagram','tiktok','note'].map(p=>{
    const cnt=d.platformSummary[p]?.count??0;
    const week=d.days.reduce((s,day)=>s+(d.daily[day]?.[p]??0),0);
    const icons={x:'𝕏',instagram:'📷',tiktok:'🎵',note:'📝'};
    return '<div class="pf-card"><div class="pf-icon" style="background:'+COLORS[p]+'22">'+icons[p]+'</div>'
      +'<div><div class="pf-name">'+p.toUpperCase()+'</div>'
      +'<div class="pf-count" style="color:'+COLORS[p]+'">'+cnt+'</div>'
      +'<div class="pf-sub">7日計 '+week+'件</div></div></div>';
  }).join('');

  const todaySlots = gSlots?.today??[];
  document.getElementById('slot-panel').innerHTML = SLOTS.map(slot=>{
    const s=todaySlots.find(x=>x.slot===slot);
    if(!s) return '<div class="slot-card"><div class="slot-name">'+SLOT_LABELS[slot]+'</div><div class="slot-count" style="color:#1e293b">—</div><div class="slot-detail">未実行</div></div>';
    const cls=s.errored===0?'done':'';
    return '<div class="slot-card '+cls+'"><div class="slot-name '+cls+'">'+SLOT_LABELS[slot]+'</div>'
      +'<div class="slot-count">'+s.succeeded+'</div>'
      +'<div class="slot-detail">成功 '+s.succeeded+' / エラー '+s.errored+'</div></div>';
  }).join('');

  document.getElementById('recent-list').innerHTML = (d.recent||[]).map(r=>{
    const p=safePlatform(r.platform??'x');
    const jst=new Date(new Date(r.postedAt).getTime()+9*3600000);
    const time=pad(jst.getUTCHours())+':'+pad(jst.getUTCMinutes());
    return '<li class="recent-item"><span class="badge badge-'+p+'">'+p.toUpperCase()+'</span>'
      +'<span class="title-text">'+esc(r.title||r.theme)+'</span>'
      +'<span class="ts">'+time+'</span>'
      +'<span class="badge '+(r.success?'badge-ok':'badge-err')+'">'+(r.success?'✓':'✗')+'</span></li>';
  }).join('');

  const thE=Object.entries(d.byTheme).sort((a,b)=>b[1]-a[1]).slice(0,8);
  mkChart('themeChart','bar',thE.map(([k])=>k),[{label:'件数',data:thE.map(([,v])=>v),backgroundColor:'#8b5cf6bb',borderRadius:4}]);
}

// ── 週間 ──
function renderWeekly() {
  const d=gStats;
  const shortDays=d.days.map(s=>s.slice(5));
  mkChart('trendChart','bar',shortDays,[
    {label:'X',data:d.days.map(day=>d.daily[day]?.x??0),backgroundColor:'#1d9bf0bb',stack:'s'},
    {label:'Instagram',data:d.days.map(day=>d.daily[day]?.instagram??0),backgroundColor:'#e1306cbb',stack:'s'},
    {label:'TikTok',data:d.days.map(day=>d.daily[day]?.tiktok??0),backgroundColor:'#69c9d0bb',stack:'s'},
    {label:'note',data:d.days.map(day=>d.daily[day]?.note??0),backgroundColor:'#41c9b4bb',stack:'s'},
  ]);
  const slotE=Object.entries(d.bySlot);
  mkChart('xSlotChart','bar',slotE.map(([k])=>SLOT_LABELS[k]??k),[{label:'件数',data:slotE.map(([,v])=>v),backgroundColor:'#1d9bf0bb',borderRadius:4}]);
  const srcE=Object.entries(d.bySource);
  mkChart('sourceChart','doughnut',srcE.map(([k])=>k),[{data:srcE.map(([,v])=>v),backgroundColor:['#1d9bf0','#f59e0b','#8b5cf6']}]);

  const wkEl=document.getElementById('weekly-kpi-bars');
  const maxV=Math.max(...d.weeklyKpi.map(w=>w.count),d.kpi.target);
  wkEl.innerHTML=d.weeklyKpi.map(w=>{
    const h=Math.max(4,Math.round((w.count/maxV)*52));
    const cls=w.count>=d.kpi.target?'achieved':w.count>0?'partial':'empty';
    return '<div class="wk-bar-wrap"><div class="wk-count">'+w.count+'</div>'
      +'<div style="flex:1;display:flex;align-items:flex-end;width:100%">'
      +'<div class="wk-bar '+cls+'" style="height:'+h+'px;width:100%"></div></div>'
      +'<div class="wk-label">'+w.date.slice(5)+'</div></div>';
  }).join('');
  const achieved=d.weeklyKpi.filter(w=>w.count>=d.kpi.target).length;
  document.getElementById('kpi-achieve-rate').textContent=achieved+'/7日 達成';
}

// ── Actions ──
function renderActions() {
  const el=document.getElementById('actions-all');
  const wfs=gActions?.workflows??[];
  if(!wfs.length){el.innerHTML='<div class="empty">データなし</div>';return;}
  el.innerHTML='<div class="card-title" style="margin-bottom:10px">全ワークフロー 直近実行</div><div class="run-list">'
    +wfs.flatMap(wf=>
      wf.runs.length===0
        ?['<div class="run-item"><div class="run-wf">'+esc(wf.label)+'</div><span class="run-name" style="color:#334155">実行履歴なし</span></div>']
        :wf.runs.map(r=>{
          const st=safeStatus(r.conclusion??r.status);
          const labels={success:'✓ 成功',failure:'✗ 失敗',in_progress:'実行中',queued:'待機中'};
          const jst=new Date(new Date(r.created_at).getTime()+9*3600000);
          const time=jst.toISOString().slice(5,16).replace('T',' ');
          const href=safeGhUrl(r.html_url);
          return '<div class="run-item">'
            +'<div class="run-status '+st+'"></div>'
            +'<div class="run-wf">'+esc(wf.label)+'</div>'
            +'<span class="run-name">'+time+'</span>'
            +'<span class="run-badge '+st+'">'+(labels[st]??'不明')+'</span>'
            +'<a class="run-link" href="'+href+'" target="_blank" rel="noopener noreferrer">→</a>'
            +'</div>';
        })
    ).join('')+'</div>';
}

// ── アフィリ ──
function renderAffiliate() {
  const aff=gAffiliate;
  const prodsEl=document.getElementById('affiliate-products');
  const logEl=document.getElementById('affiliate-log');
  if(!aff){prodsEl.innerHTML='<div class="empty">データなし</div>';logEl.innerHTML='<div class="empty">投稿ログなし</div>';return;}

  const RANK_EMOJI=['','🥇','🥈','🥉','4️⃣','5️⃣'];
  const prods=aff.products??[];
  if(prods.length===0){prodsEl.innerHTML='<div class="empty">data/affiliate-products.json が見つかりません</div>';}
  else{
    prodsEl.innerHTML='<div class="card-title">ランキング商品 ('+prods.length+'件)</div><div class="prod-grid">'
      +prods.slice(0,5).map((p,i)=>{
        const rank=p.salesRank??p.rank??(i+1);
        const em=RANK_EMOJI[rank]??'🏅';
        const priceStr=p.price?'¥'+Number(p.price).toLocaleString():'';
        const rating=p.rating?'★'+p.rating+(p.reviewCount?' ('+p.reviewCount+'件)':''):'';
        return '<div class="prod-card">'
          +'<div class="prod-rank">'+em+'</div>'
          +'<div class="prod-info">'
          +'<div class="prod-name">'+esc(String(p.name??''))+'</div>'
          +'<div class="prod-meta">'+esc(String(p.category??''))+(rating?' &nbsp;·&nbsp; '+rating:'')+'</div>'
          +(priceStr?'<div class="prod-price">'+priceStr+'</div>':'')
          +(p.highlight?'<div class="prod-meta" style="color:#94a3b8;margin-top:3px">'+esc(String(p.highlight??''))+'</div>':'')
          +'</div>'
          +(p.affiliateUrl?'<a class="prod-link" href="'+safeUrl(String(p.affiliateUrl??''))+'" target="_blank" rel="noopener noreferrer">購入↗</a>':'')
          +'</div>';
      }).join('')+'</div>';
  }

  const posts=aff.recentPosts??[];
  if(posts.length===0){logEl.innerHTML='<div class="card-title">投稿履歴</div><div class="empty">まだ投稿履歴がありません<br><span style="font-size:.72rem;color:#475569">npm run affiliate:post を実行すると記録されます</span></div>';}
  else{
    logEl.innerHTML='<div class="card-title">投稿履歴（直近 '+posts.length+'件）</div><ul class="affiliate-log">'
      +posts.map(p=>{
        const jst=new Date(new Date(p.postedAt).getTime()+9*3600000);
        const time=jst.toISOString().slice(0,16).replace('T',' ');
        const names=(p.products??[]).map(x=>x.rank+'位: '+x.name).join(' / ');
        return '<li class="aff-item">'
          +'<span class="badge badge-'+safePlatform(p.platform??'x')+'">'+esc((p.platform??'X').toUpperCase())+'</span>'
          +'<div class="aff-names">'+esc(names||p.rankingTitle||'—')+'</div>'
          +'<span class="ts">'+time+'</span>'
          +'<span class="badge '+(p.success?'badge-ok':'badge-err')+'">'+(p.success?'✓':'✗')+'</span>'
          +(p.dryRun?'<span class="badge" style="background:#33415522;color:#64748b">dry</span>':'')
          +'</li>';
      }).join('')+'</ul>';
  }
}

// ── Imp/PV ──
function renderKpi() {
  const entries=gKpi?.entries??[];
  const days14=last14Days();
  const platforms=['x','instagram','tiktok','note','forte','affiliate'];
  const PF_COLORS={x:'#1d9bf0',instagram:'#e1306c',tiktok:'#69c9d0',note:'#41c9b4',forte:'#a78bfa',affiliate:'#fb923c'};
  const shortDays=days14.map(d=>d.slice(5));

  function aggByDay(field){
    return platforms.map(p=>({
      label:p.toUpperCase(),
      data:days14.map(day=>{
        const v=entries.filter(e=>e.date===day&&e.platform===p).reduce((s,e)=>s+(e[field]??0),0);
        return v||null;
      }),
      backgroundColor:PF_COLORS[p]+'bb',
      borderColor:PF_COLORS[p],
      borderWidth:1.5,
      borderRadius:3,
      spanGaps:true,
    }));
  }

  mkChart('impChart','bar',shortDays,aggByDay('imp'));
  mkChart('pvChart','bar',shortDays,aggByDay('pv'));

  const clickDs=aggByDay('clicks').map(d=>({...d,type:'bar'}));
  const revDs=aggByDay('revenue').map(d=>({...d,type:'bar'}));
  mkChart('clickChart','bar',shortDays,clickDs);
  mkChart('revenueChart','bar',shortDays,revDs);

  const histEl=document.getElementById('kpi-history');
  if(!entries.length){histEl.innerHTML='<div class="empty">まだ入力データがありません</div>';return;}
  histEl.innerHTML='<div class="card-title">入力履歴（直近'+Math.min(entries.length,20)+'件）</div>'
    +'<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.78rem">'
    +'<thead><tr style="color:#475569;border-bottom:1px solid #1e293b">'
    +'<th style="text-align:left;padding:6px 8px">日付</th>'
    +'<th style="text-align:left;padding:6px 8px">PF</th>'
    +'<th style="text-align:right;padding:6px 8px">Imp</th>'
    +'<th style="text-align:right;padding:6px 8px">PV</th>'
    +'<th style="text-align:right;padding:6px 8px">Click</th>'
    +'<th style="text-align:right;padding:6px 8px">収益</th>'
    +'<th style="text-align:left;padding:6px 8px">メモ</th>'
    +'</tr></thead><tbody>'
    +[...entries].reverse().slice(0,20).map(e=>'<tr style="border-bottom:1px solid #0f1929">'
      +'<td style="padding:5px 8px;color:#64748b">'+esc(e.date||'—')+'</td>'
      +'<td style="padding:5px 8px"><span class="badge badge-'+safePlatform(e.platform||'x')+'">'+esc((e.platform||'?').toUpperCase())+'</span></td>'
      +'<td style="padding:5px 8px;text-align:right;color:#94a3b8">'+(e.imp!=null?Number(e.imp).toLocaleString():'—')+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:#94a3b8">'+(e.pv!=null?Number(e.pv).toLocaleString():'—')+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:#94a3b8">'+(e.clicks!=null?Number(e.clicks).toLocaleString():'—')+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:#a78bfa">'+(e.revenue!=null?'¥'+Number(e.revenue).toLocaleString():'—')+'</td>'
      +'<td style="padding:5px 8px;color:#475569;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(e.note||'')+'</td>'
      +'</tr>').join('')
    +'</tbody></table></div>';
}

function last14Days(){
  return Array.from({length:14},(_,i)=>{
    const d=new Date();d.setDate(d.getDate()-(13-i));
    return d.toISOString().slice(0,10);
  });
}

async function saveKpi(){
  const date=document.getElementById('kpi-date').value;
  const platform=document.getElementById('kpi-platform').value;
  const imp=Number(document.getElementById('kpi-imp').value)||undefined;
  const pv=Number(document.getElementById('kpi-pv').value)||undefined;
  const clicks=Number(document.getElementById('kpi-clicks').value)||undefined;
  const revenue=Number(document.getElementById('kpi-revenue').value)||undefined;
  const note=document.getElementById('kpi-note').value||undefined;
  const msgEl=document.getElementById('kpi-msg');
  if(!date||!platform){msgEl.className='form-msg err';msgEl.textContent='日付とプラットフォームは必須です';return;}
  try{
    const r=await fetch('/api/kpi-manual',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date,platform,imp,pv,clicks,revenue,note})});
    const j=await r.json();
    if(j.ok){
      msgEl.className='form-msg ok';msgEl.textContent='✅ 保存しました';
      await fetch('/api/kpi-manual').then(r=>r.json()).then(d=>{gKpi=d;});
      renderKpi();
    }else{msgEl.className='form-msg err';msgEl.textContent='エラー: '+String(j.error);}
  }catch(e){msgEl.className='form-msg err';msgEl.textContent='通信エラー: '+String(e);}
}

// ── PDCA ──
function renderPdca(){
  const stEl=document.getElementById('strategy-panel');
  const sg=gStrategy;
  if(!sg?.exists||!sg.strategy){
    stEl.innerHTML='<div class="card-title">現在の戦略</div><div class="empty">strategy.json なし (pdca:analyze 未実行)</div>';
  }else{
    const s=sg.strategy;
    const themes=s.themeWeights??s.themes??{};
    const sorted=Object.entries(themes).sort((a,b)=>b[1]-a[1]);
    const maxW=sorted[0]?.[1]??1;
    stEl.innerHTML='<div class="card-title">投稿テーマ ウェイト</div>'
      +'<div class="strategy-wrap">'+sorted.map(([k,v])=>{
        const pct=Math.round((v/maxW)*100);
        return '<div class="strategy-item">'
          +'<div class="strategy-label">'+esc(String(k))+'</div>'
          +'<div class="strategy-bar-wrap"><div class="strategy-bar" style="width:'+pct+'%"></div></div>'
          +'<div class="strategy-pct">'+Math.round(Number(v)*100)+'%</div></div>';
      }).join('')+'</div>'
      +(s.updatedAt?'<div style="font-size:.7rem;color:#334155;margin-top:8px;padding-top:8px;border-top:1px solid #1e293b">最終更新: '+new Date(s.updatedAt).toLocaleString("ja-JP")+'</div>':'')
      +(s.insight?'<div style="font-size:.74rem;color:#64748b;margin-top:8px;line-height:1.5;border-top:1px solid #1e293b;padding-top:8px">'+esc(s.insight)+'</div>':'');
  }

  const history=gSlots?.history??[];
  const bySlotTotal={};
  SLOTS.forEach(s=>bySlotTotal[s]=0);
  for(const r of history){if(SLOTS.includes(r.slot))bySlotTotal[r.slot]=(bySlotTotal[r.slot]??0)+r.succeeded;}
  mkChart('pdcaSlotChart','bar',SLOTS.map(s=>SLOT_LABELS[s]),[{label:'累計成功',data:SLOTS.map(s=>bySlotTotal[s]),backgroundColor:'#a78bfabb',borderRadius:4}]);

  const hist35=history.slice(-35);
  mkChart('slotHistChart','bar',hist35.map(r=>r.date.slice(5)+' '+r.slot.replace('slot','')), [
    {label:'成功',data:hist35.map(r=>r.succeeded),backgroundColor:'#22c55e88',borderRadius:2},
    {label:'エラー',data:hist35.map(r=>r.errored),backgroundColor:'#ef444488',borderRadius:2},
  ]);
}

// ── ヘルパー ──
function kpiCard(label,value,sub,cls,pct=null){
  const color=cls==='ok'?'#22c55e':cls==='warn'?'#f59e0b':cls==='err'?'#ef4444':cls==='purple'?'#a78bfa':'#60a5fa';
  const bar=pct!==null?'<div class="progress-bar"><div class="progress-fill" style="width:'+pct+'%;background:'+color+'"></div></div>':'';
  return '<div class="kpi-card '+cls+'"><div class="kpi-label">'+label+'</div>'
    +'<div class="kpi-value '+cls+'">'+value+'</div>'
    +'<div class="kpi-sub">'+sub+'</div>'+bar+'</div>';
}

function mkChart(id,type,labels,datasets){
  if(charts[id])charts[id].destroy();
  const el=document.getElementById(id);if(!el)return;
  charts[id]=new Chart(el.getContext('2d'),{
    type,data:{labels,datasets},
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{color:'#64748b',font:{size:10},boxWidth:9}}},
      scales:(type!=='pie'&&type!=='doughnut')?{
        x:{ticks:{color:'#475569',font:{size:9}},grid:{color:'#0f172a'},stacked:datasets.some(d=>d.stack)},
        y:{ticks:{color:'#475569',font:{size:9}},grid:{color:'#1e293b'},beginAtZero:true,stacked:datasets.some(d=>d.stack)},
      }:undefined,
    }
  });
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function pad(n){return String(n).padStart(2,'0');}
function safeStatus(raw){const K=['success','failure','in_progress','queued','skipped'];return K.includes(raw)?raw:'queued';}
function safePlatform(raw){const K=['x','instagram','tiktok','note','forte','affiliate'];return K.includes(raw)?raw:'x';}
/** https:// または http:// のみ許可する URL サニタイザー */
function safeUrl(url){
  if(typeof url!=='string')return '#';
  try{
    const u=new URL(url);
    if(u.protocol!=='https:'&&u.protocol!=='http:')return '#';
    return esc(url);
  }catch{return '#';}
}
/** GitHub Actions URL のみ許可 */
function safeGhUrl(url){return typeof url==='string'&&url.startsWith('https://github.com/')?esc(url):'#';}

// 今日の日付をデフォルト値にセット
document.addEventListener('DOMContentLoaded',()=>{
  const today=new Date().toISOString().slice(0,10);
  const el=document.getElementById('kpi-date');
  if(el)el.value=today;
});

setInterval(()=>{
  document.getElementById('clock').textContent=new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
},1000);

setInterval(loadAll,2*60*1000);
loadAll();
</script>
</body>
</html>`;

app.get('/', (_req, res) => res.send(HTML));

app.listen(PORT, () => {
  console.log('\n🕊️  SNS 投稿ダッシュボード起動');
  console.log('   http://localhost:' + PORT);
  console.log('   Ctrl+C で停止\n');
});
