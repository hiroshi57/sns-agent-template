/**
 * scripts/generate-dashboard.ts
 *
 * data/x-analytics.jsonl を読み込み、docs/index.html を再生成する。
 * save-analytics.sh から自動呼び出しされるほか、手動でも実行可能。
 *
 * 使い方:
 *   npm run dashboard:generate
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const ANALYTICS_FILE = path.join(ROOT, 'data', 'x-analytics.jsonl');
const OUTPUT_FILE = path.join(ROOT, 'docs', 'index.html');
const DAYS = 14; // 表示する日数

interface AnalyticsRecord {
  postedAt: string;
  slot: string;
  platform?: string;
  theme: string;
  source: string;
  url: string;
  title: string;
  success: boolean;
}

// ── ユーティリティ ──────────────────────────────────────────────

function toJST(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) as T; } catch { return null; } })
    .filter((r): r is T => r !== null);
}

// ── データ読み込み ───────────────────────────────────────────────

const records = readJsonl<AnalyticsRecord>(ANALYTICS_FILE);

// 直近 DAYS 日の日付リスト (JST, 昇順)
const dates: string[] = [];
for (let i = DAYS - 1; i >= 0; i--) {
  const d = new Date();
  d.setDate(d.getDate() - i);
  dates.push(d.toISOString().slice(0, 10));
}

// ── 集計 ─────────────────────────────────────────────────────────

type DaySummary = { x: number; instagram: number; tiktok: number; note: number; total: number };
const byDay: Record<string, DaySummary> = {};
for (const date of dates) {
  byDay[date] = { x: 0, instagram: 0, tiktok: 0, note: 0, total: 0 };
}

for (const r of records) {
  if (!r.success) continue;
  const day = toJST(r.postedAt);
  if (!byDay[day]) continue;
  const plat = (r.platform ?? 'x') as keyof DaySummary;
  if (plat in byDay[day]) {
    (byDay[day][plat] as number) += 1;
  }
  byDay[day].total += 1;
}

const totalSuccess = records.filter(r => r.success).length;
const totalFail = records.filter(r => !r.success).length;
const total = records.length;
const errorRate = total > 0 ? Math.round(totalFail / total * 1000) / 10 : 0;

const last7 = dates.slice(-7);
const avg7 = Math.round(
  last7.reduce((s, d) => s + (byDay[d]?.total ?? 0), 0) / 7 * 10
) / 10;

// ── Chart.js データ ───────────────────────────────────────────────

const PLATFORM_COLORS: Record<string, { bg: string; border: string }> = {
  x:         { bg: 'rgba(29, 161, 242, 0.8)',  border: 'rgb(29, 161, 242)' },
  instagram: { bg: 'rgba(193, 53, 132, 0.8)',  border: 'rgb(193, 53, 132)' },
  tiktok:    { bg: 'rgba(69, 201, 208, 0.8)',  border: 'rgb(69, 201, 208)' },
  note:      { bg: 'rgba(0, 199, 170, 0.8)',   border: 'rgb(0, 199, 170)'  },
};

const chartData = {
  labels: dates,
  datasets: (['x', 'instagram', 'tiktok', 'note'] as const).map(p => ({
    label: p,
    data: dates.map(d => byDay[d]?.[p] ?? 0),
    backgroundColor: PLATFORM_COLORS[p].bg,
    borderColor: PLATFORM_COLORS[p].border,
    borderWidth: 2,
  })),
};

// ── テーブル行 ────────────────────────────────────────────────────

const tableRows = [...dates].reverse().map(date => {
  const d = byDay[date];
  const t = d.total;
  const cls = t >= 15 ? 'green' : 'red';
  const icon = t >= 15 ? '✅' : '❌';
  return `    <tr>
      <td>${date}</td>
      <td>${d.x}</td><td>${d.instagram}</td><td>${d.tiktok}</td><td>${d.note}</td>
      <td><span class="${cls}">${icon} ${t}</span></td>
    </tr>`;
}).join('\n');

// ── HTML 生成 ─────────────────────────────────────────────────────

const updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

const avgClass = avg7 >= 15 ? 'green' : avg7 >= 10 ? 'yellow' : 'red';
const errClass = errorRate <= 10 ? 'green' : 'red';
const failClass = totalFail === 0 ? 'green' : 'red';

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI News Bot ダッシュボード</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f5f5f5; color: #333; }
    h1 { color: #1a1a2e; }
    .cards { display: flex; gap: 16px; flex-wrap: wrap; margin: 20px 0; }
    .card { background: white; border-radius: 12px; padding: 20px 28px; box-shadow: 0 2px 8px rgba(0,0,0,.08); min-width: 140px; }
    .card .label { font-size: 12px; color: #888; text-transform: uppercase; }
    .card .value { font-size: 32px; font-weight: 700; margin-top: 4px; }
    .card .value.green { color: #22c55e; }
    .card .value.yellow { color: #f59e0b; }
    .card .value.red { color: #ef4444; }
    .chart-box { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,.08); margin: 20px 0; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    th { background: #1a1a2e; color: white; padding: 12px 16px; text-align: center; font-size: 13px; }
    td { padding: 10px 16px; text-align: center; border-bottom: 1px solid #eee; font-size: 13px; }
    tr:last-child td { border-bottom: none; }
    .green { color: #22c55e; font-weight: 600; }
    .yellow { color: #f59e0b; font-weight: 600; }
    .red { color: #ef4444; font-weight: 600; }
    .footer { text-align: center; color: #aaa; font-size: 12px; margin-top: 32px; }
  </style>
</head>
<body>
  <h1>🤖 AI News Bot ダッシュボード</h1>
  <p style="color:#888; font-size:13px;">最終更新: ${updatedAt}</p>

  <div class="cards">
    <div class="card">
      <div class="label">直近7日平均</div>
      <div class="value ${avgClass}">${avg7}</div>
    </div>
    <div class="card">
      <div class="label">総成功投稿</div>
      <div class="value green">${totalSuccess}</div>
    </div>
    <div class="card">
      <div class="label">総失敗</div>
      <div class="value ${failClass}">${totalFail}</div>
    </div>
    <div class="card">
      <div class="label">エラー率</div>
      <div class="value ${errClass}">${errorRate}%</div>
    </div>
  </div>

  <div class="chart-box">
    <h2>📊 プラットフォーム別 日次投稿数（直近${DAYS}日）</h2>
    <canvas id="chart" style="max-height:400px"></canvas>
  </div>

  <h2>📅 日別詳細</h2>
  <table>
    <thead>
      <tr>
        <th>日付</th>
        <th>X</th>
        <th>Instagram</th>
        <th>TikTok</th>
        <th>note</th>
        <th>合計</th>
      </tr>
    </thead>
    <tbody>
${tableRows}
    </tbody>
  </table>

  <div class="footer">KPI 目標: 日次 ≥15件 / エラー率 ≤10%</div>

  <script>
    new Chart(document.getElementById('chart'), {
      type: 'bar',
      data: ${JSON.stringify(chartData)},
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' } },
        scales: {
          x: { stacked: true },
          y: { stacked: true, beginAtZero: true },
        },
      },
    });
  </script>
</body>
</html>`;

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');
console.log(`[generate-dashboard] docs/index.html を更新しました`);
console.log(`  レコード数: ${records.length} (成功: ${totalSuccess} / 失敗: ${totalFail})`);
console.log(`  直近7日平均: ${avg7} 件/日`);
