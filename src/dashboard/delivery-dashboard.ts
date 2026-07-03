/**
 * 配信実績 分析ダッシュボード（静的HTMLレポート生成）
 *
 * X / Note / Instagram / アフィリエイト / MicroApps の配信実績を集計し、
 * サーバー不要で開ける自己完結HTMLレポートを生成する。
 *
 * 使い方:
 *   npm run dashboard:delivery
 *   → dashboard/delivery-report.html を生成（ブラウザで開くだけ）
 *
 * データソース（存在するものだけ集計。無ければ 0 件扱い）:
 *   data/x-analytics-daily.jsonl  … X 日次パフォーマンス（imp/engagement）
 *   data/adaptive-config.json     … 自動スケール level 履歴
 *   data/slot-performance.json    … スロット別効率
 *   data/micro-apps-post-log.jsonl… MicroApps 配信ログ（post-micro-apps.ts が記録）
 *   data/affiliate-post-log.jsonl … アフィリエイト投稿
 *   data/note-weekly-log.json     … Note 投稿
 *   data/instagram-posted-urls.json … Instagram 投稿
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const OUT_DIR = path.join(process.cwd(), 'dashboard');
const OUT_FILE = path.join(OUT_DIR, 'delivery-report.html');
const TARGET_IMP_PER_DAY = 1500;

// ── ユーティリティ ──────────────────────────────────────────

function readJsonl<T>(file: string): T[] {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8')
    .split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as T; } catch { return null; } })
    .filter((r): r is T => r !== null);
}

function readJson<T>(file: string, fallback: T): T {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return fallback; }
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toJSTDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ── データ型 ────────────────────────────────────────────────

interface DailyAnalytics {
  date: string;
  count: number;
  totalImpressions: number;
  avgImpressions: number;
  totalLikes: number;
  totalRTs: number;
  totalReplies: number;
  engagementRate: number;
}

interface AdaptiveHistory { date: string; level: number; avgImpPerDay: number; action: string; }
interface AdaptiveConfig {
  updatedAt?: string;
  level?: number;
  targetImpPerDay?: number;
  reason?: string;
  history?: AdaptiveHistory[];
}

interface SlotPerf {
  slot: string; runs: number; totalSucceeded: number; totalErrored: number;
  successRate: number; efficiency: number;
}
interface SlotPerfFile { generatedAt?: string; windowDays?: number; slots?: SlotPerf[]; }

interface MicroAppLog {
  postedAt: string; channel: string; slug: string; title: string;
  template: string; url: string; success: boolean;
}

// ── 集計 ────────────────────────────────────────────────────

function buildData() {
  const daily = readJsonl<DailyAnalytics>('x-analytics-daily.jsonl')
    .sort((a, b) => a.date.localeCompare(b.date));
  const adaptive = readJson<AdaptiveConfig>('adaptive-config.json', {});
  const slotFile = readJson<SlotPerfFile>('slot-performance.json', {});
  const microApps = readJsonl<MicroAppLog>('micro-apps-post-log.jsonl')
    .filter((r) => r.success)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

  // チャネル別配信数
  const affiliate = readJsonl<{ success?: boolean; dryRun?: boolean }>('affiliate-post-log.jsonl')
    .filter((r) => r.success && !r.dryRun).length;

  // ネタ（relief）配信数 — x-analytics.jsonl の slot='relief' 成功レコードを集計
  const relief = readJsonl<{ slot?: string; success?: boolean }>('x-analytics.jsonl')
    .filter((r) => r.slot === 'relief' && r.success).length;

  // リポジトリ（テンプレート配布）配信数 — data/repo-template-log.jsonl（配信開始後に記録）
  const repoTemplate = readJsonl<{ success?: boolean }>('repo-template-log.jsonl')
    .filter((r) => r.success !== false).length;

  const noteFile = readJson<{ items?: unknown[] }>('note-weekly-log.json', {});
  const noteCount = Array.isArray(noteFile.items) ? noteFile.items.length : 0;

  const igFile = readJson<{ entries?: Record<string, unknown> | unknown[] }>('instagram-posted-urls.json', {});
  const igCount = Array.isArray(igFile.entries)
    ? igFile.entries.length
    : igFile.entries ? Object.keys(igFile.entries).length : 0;

  const xTotalPosts = daily.reduce((a, d) => a + (d.count ?? 0), 0);

  // MicroApps アプリ別集計
  const byApp = new Map<string, { title: string; count: number; lastPostedAt: string }>();
  for (const m of microApps) {
    const cur = byApp.get(m.slug) ?? { title: m.title, count: 0, lastPostedAt: m.postedAt };
    cur.count += 1;
    if (m.postedAt > cur.lastPostedAt) cur.lastPostedAt = m.postedAt;
    byApp.set(m.slug, cur);
  }

  return {
    generatedAt: new Date().toISOString(),
    daily,
    adaptive,
    slots: (slotFile.slots ?? []).slice().sort((a, b) => b.efficiency - a.efficiency),
    slotWindowDays: slotFile.windowDays ?? 0,
    microApps,
    microAppsByApp: [...byApp.entries()].map(([slug, v]) => ({ slug, ...v }))
      .sort((a, b) => b.count - a.count),
    channels: {
      x: xTotalPosts,
      note: noteCount,
      instagram: igCount,
      affiliate,
      microApps: microApps.length,
      relief,
      repoTemplate,
    },
  };
}

type DashboardData = ReturnType<typeof buildData>;

// ── HTML 生成 ───────────────────────────────────────────────

function renderHtml(d: DashboardData): string {
  const latest = d.daily[d.daily.length - 1];
  const latestAvg = latest?.avgImpressions ?? 0;
  const pctOfTarget = Math.round((latestAvg / TARGET_IMP_PER_DAY) * 100);
  const level = d.adaptive.level ?? '-';
  const last7 = d.daily.slice(-7);
  const sum7Imp = last7.reduce((a, x) => a + (x.totalImpressions ?? 0), 0);
  const sum7Posts = last7.reduce((a, x) => a + (x.count ?? 0), 0);

  const chartLabels = JSON.stringify(d.daily.map((x) => x.date));
  const chartImp = JSON.stringify(d.daily.map((x) => x.avgImpressions));
  const chartPosts = JSON.stringify(d.daily.map((x) => x.count));
  const chartEng = JSON.stringify(d.daily.map((x) => +(x.engagementRate * 100).toFixed(2)));
  const adaptiveHist = (d.adaptive.history ?? []).slice().reverse();
  const chartLevelLabels = JSON.stringify(adaptiveHist.map((h) => h.date));
  const chartLevel = JSON.stringify(adaptiveHist.map((h) => h.level));

  const channelRows = [
    ['X（ツイート総数）', d.channels.x, '🐦'],
    ['ネタ（気休め）', d.channels.relief, '💚'],
    ['アフィリエイト', d.channels.affiliate, '🛒'],
    ['MicroApps 紹介（ゲーム）', d.channels.microApps, '📱'],
    ['リポジトリ（テンプレ配布）', d.channels.repoTemplate, '📦'],
    ['Note', d.channels.note, '📝'],
    ['Instagram', d.channels.instagram, '📷'],
  ].map(([label, n, ic]) =>
    `<tr><td>${ic} ${esc(label)}</td><td class="num">${esc(n)}</td></tr>`).join('');

  const microAppRows = d.microAppsByApp.length
    ? d.microAppsByApp.map((a) =>
        `<tr><td>${esc(a.title)}</td><td class="mono">${esc(a.slug)}</td><td class="num">${a.count}</td><td>${esc(toJSTDate(a.lastPostedAt))}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">まだ MicroApps の配信実績がありません（配信再開後に記録されます）</td></tr>`;

  const recentMicro = d.microApps.slice(0, 15);
  const recentRows = recentMicro.length
    ? recentMicro.map((m) =>
        `<tr><td>${esc(toJSTDate(m.postedAt))}</td><td>${esc(m.title)}</td><td>${esc(m.template)}</td><td><a href="${esc(m.url)}" target="_blank" rel="noopener">開く</a></td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">配信ログなし</td></tr>`;

  const slotRows = d.slots.length
    ? d.slots.map((s) =>
        `<tr><td class="mono">${esc(s.slot)}</td><td class="num">${s.runs}</td><td class="num">${s.totalSucceeded}</td><td class="num">${(s.successRate * 100).toFixed(0)}%</td><td class="num">${(s.efficiency * 100).toFixed(0)}%</td></tr>`).join('')
    : `<tr><td colspan="5" class="empty">スロットデータなし</td></tr>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>配信実績ダッシュボード — chatwork-x-automation</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<style>
  :root { --bg:#0f1115; --card:#1a1d24; --line:#2a2e37; --txt:#e6e8eb; --sub:#9aa0aa; --accent:#4f8cff; --good:#34d399; --warn:#fbbf24; --bad:#f87171; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:'Inter','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif; background:var(--bg); color:var(--txt); }
  .wrap { max-width:1100px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-size:24px; margin:0 0 4px; }
  .sub { color:var(--sub); font-size:13px; margin-bottom:28px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin-bottom:28px; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; }
  .kpi .label { color:var(--sub); font-size:12px; }
  .kpi .val { font-size:28px; font-weight:700; margin-top:6px; }
  .kpi .meta { font-size:12px; margin-top:4px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:22px; }
  .card h2 { font-size:16px; margin:0 0 16px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--sub); font-weight:600; font-size:12px; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.mono { font-family:ui-monospace,monospace; color:var(--sub); }
  td.empty { color:var(--sub); text-align:center; padding:20px; }
  a { color:var(--accent); text-decoration:none; }
  .good { color:var(--good); } .warn { color:var(--warn); } .bad { color:var(--bad); }
  canvas { max-height:280px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:22px; }
  @media (max-width:720px){ .grid2 { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>📊 配信実績ダッシュボード</h1>
  <div class="sub">生成: ${esc(toJSTDate(d.generatedAt))} ${esc(new Date(d.generatedAt).toLocaleTimeString('ja-JP'))} JST ・ データソース: data/*.jsonl, *.json</div>

  <div class="kpis">
    <div class="kpi"><div class="label">最新 平均インプレッション/日</div><div class="val ${pctOfTarget >= 100 ? 'good' : pctOfTarget >= 50 ? 'warn' : 'bad'}">${esc(latestAvg)}</div><div class="meta sub">目標 ${TARGET_IMP_PER_DAY} の ${pctOfTarget}%</div></div>
    <div class="kpi"><div class="label">自動スケール Level</div><div class="val">${esc(level)}</div><div class="meta sub">${esc(d.adaptive.reason ?? '')}</div></div>
    <div class="kpi"><div class="label">直近7日 インプレッション計</div><div class="val">${esc(sum7Imp.toLocaleString())}</div><div class="meta sub">投稿 ${esc(sum7Posts)} 件</div></div>
    <div class="kpi"><div class="label">MicroApps 配信数（累計）</div><div class="val">${esc(d.channels.microApps)}</div><div class="meta sub">${d.channels.microApps === 0 ? '配信再開後に記録' : `${d.microAppsByApp.length} アプリ`}</div></div>
  </div>

  <div class="grid2">
    <div class="card"><h2>インプレッション推移（平均/日）</h2><canvas id="impChart"></canvas></div>
    <div class="card"><h2>日次投稿数 & エンゲージメント率</h2><canvas id="postChart"></canvas></div>
  </div>

  <div class="card"><h2>自動スケール Level 履歴</h2><canvas id="levelChart"></canvas></div>

  <div class="grid2">
    <div class="card"><h2>チャネル別 配信実績</h2>
      <table><thead><tr><th>チャネル</th><th class="num">配信数</th></tr></thead><tbody>${channelRows}</tbody></table>
    </div>
    <div class="card"><h2>スロット別 効率（直近${esc(d.slotWindowDays)}日）</h2>
      <table><thead><tr><th>スロット</th><th class="num">実行</th><th class="num">成功</th><th class="num">成功率</th><th class="num">効率</th></tr></thead><tbody>${slotRows}</tbody></table>
    </div>
  </div>

  <div class="card"><h2>📱 MicroApps アプリ別 配信実績</h2>
    <table><thead><tr><th>アプリ</th><th>slug</th><th class="num">配信数</th><th>最終配信</th></tr></thead><tbody>${microAppRows}</tbody></table>
  </div>

  <div class="card"><h2>📱 MicroApps 直近の配信ログ</h2>
    <table><thead><tr><th>日付</th><th>アプリ</th><th>テンプレ</th><th>リンク</th></tr></thead><tbody>${recentRows}</tbody></table>
  </div>
</div>

<script>
  const opts = (title) => ({ responsive:true, plugins:{ legend:{ labels:{ color:'#9aa0aa' } } },
    scales:{ x:{ ticks:{ color:'#9aa0aa' }, grid:{ color:'#2a2e37' } }, y:{ ticks:{ color:'#9aa0aa' }, grid:{ color:'#2a2e37' } } } });
  new Chart(document.getElementById('impChart'), {
    type:'line',
    data:{ labels:${chartLabels}, datasets:[
      { label:'平均imp/日', data:${chartImp}, borderColor:'#4f8cff', backgroundColor:'rgba(79,140,255,.15)', fill:true, tension:.3 },
      { label:'目標(${TARGET_IMP_PER_DAY})', data:${chartLabels}.map(()=>${TARGET_IMP_PER_DAY}), borderColor:'#fbbf24', borderDash:[6,4], pointRadius:0 }
    ]}, options:opts() });
  new Chart(document.getElementById('postChart'), {
    type:'bar',
    data:{ labels:${chartLabels}, datasets:[
      { label:'投稿数', data:${chartPosts}, backgroundColor:'#34d399', yAxisID:'y' },
      { label:'エンゲージ率(%)', type:'line', data:${chartEng}, borderColor:'#f87171', yAxisID:'y1', tension:.3 }
    ]}, options:{ ...opts(), scales:{ x:{ ticks:{color:'#9aa0aa'}, grid:{color:'#2a2e37'} }, y:{ position:'left', ticks:{color:'#9aa0aa'}, grid:{color:'#2a2e37'} }, y1:{ position:'right', ticks:{color:'#9aa0aa'}, grid:{display:false} } } } });
  new Chart(document.getElementById('levelChart'), {
    type:'line',
    data:{ labels:${chartLevelLabels}, datasets:[
      { label:'Level', data:${chartLevel}, borderColor:'#a78bfa', backgroundColor:'rgba(167,139,250,.15)', fill:true, stepped:true }
    ]}, options:{ ...opts(), scales:{ x:{ ticks:{color:'#9aa0aa'}, grid:{color:'#2a2e37'} }, y:{ min:0, max:4, ticks:{ stepSize:1, color:'#9aa0aa' }, grid:{color:'#2a2e37'} } } } });
</script>
</body>
</html>`;
}

// ── メイン ──────────────────────────────────────────────────

function main(): void {
  const data = buildData();
  const html = renderHtml(data);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html, 'utf-8');

  console.log('✅ 配信実績ダッシュボードを生成しました');
  console.log(`   出力: ${OUT_FILE}`);
  console.log(`   X日次データ: ${data.daily.length} 日分`);
  console.log(`   チャネル別配信: X=${data.channels.x} / ネタ=${data.channels.relief} / Affiliate=${data.channels.affiliate} / MicroApps=${data.channels.microApps} / リポジトリ=${data.channels.repoTemplate} / Note=${data.channels.note} / IG=${data.channels.instagram}`);
  console.log(`   ブラウザで dashboard/delivery-report.html を開いてください`);
}

main();
