#!/usr/bin/env node
/**
 * 全プラットフォーム投稿数ダッシュボード生成 (#42)
 *
 * data/x-analytics.jsonl を読み込んで docs/index.html を生成する。
 * GitHub Pages で公開することで投稿状況をブラウザから確認できる。
 *
 * 使い方:
 *   node scripts/generate-dashboard.js
 */

const fs = require('fs');
const path = require('path');

const ANALYTICS_FILE = path.join(process.cwd(), 'data', 'x-analytics.jsonl');
const OUTPUT_FILE = path.join(process.cwd(), 'docs', 'index.html');
const DAYS = 14;   // 表示する日数

const PLATFORM_COLORS = {
  x:         { bg: 'rgba(29, 161, 242, 0.8)',   border: 'rgb(29, 161, 242)' },
  instagram: { bg: 'rgba(193, 53, 132, 0.8)',  border: 'rgb(193, 53, 132)' },
  tiktok:    { bg: 'rgba(0, 0, 0, 0.8)',        border: 'rgb(0, 0, 0)' },
  note:      { bg: 'rgba(0, 199, 170, 0.8)',    border: 'rgb(0, 199, 170)' },
};

// ── データ読み込み ──────────────────────────────────────────────────

function loadAnalytics() {
  if (!fs.existsSync(ANALYTICS_FILE)) return [];
  const lines = fs.readFileSync(ANALYTICS_FILE, 'utf-8').split('\n').filter(Boolean);
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return records;
}

// ── 直近 N 日分の日付ラベル ──────────────────────────────────────────

function getDateLabels(days) {
  const labels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    labels.push(d.toISOString().slice(0, 10));
  }
  return labels;
}

// ── 集計 ────────────────────────────────────────────────────────────

function aggregate(records, dateLabels) {
  const platforms = ['x', 'instagram', 'tiktok', 'note'];
  // { date -> { platform -> count } }
  const byDate = {};
  for (const d of dateLabels) {
    byDate[d] = {};
    for (const p of platforms) byDate[d][p] = 0;
  }

  let totalSuccess = 0;
  let totalFail = 0;

  for (const rec of records) {
    const date = (rec.postedAt || '').slice(0, 10);
    if (!byDate[date]) continue;
    const platform = rec.platform || 'x';
    byDate[date][platform] = (byDate[date][platform] || 0) + 1;
    if (rec.success) totalSuccess++; else totalFail++;
  }

  // プラットフォーム別データセット
  const datasets = platforms.map(p => ({
    label: p,
    data: dateLabels.map(d => byDate[d][p] || 0),
    ...(PLATFORM_COLORS[p] || { bg: 'rgba(128,128,128,0.8)', border: 'gray' }),
  }));

  // 日別合計
  const dailyTotals = dateLabels.map(d =>
    platforms.reduce((sum, p) => sum + (byDate[d][p] || 0), 0)
  );

  // 直近7日平均
  const last7 = dailyTotals.slice(-7);
  const avg7 = last7.length > 0
    ? Math.round(last7.reduce((a, b) => a + b, 0) / last7.length * 10) / 10
    : 0;

  const errorRate = (totalSuccess + totalFail) > 0
    ? Math.round((totalFail / (totalSuccess + totalFail)) * 1000) / 10
    : 0;

  return { datasets, dailyTotals, avg7, totalSuccess, totalFail, errorRate };
}

// ── HTML 生成 ────────────────────────────────────────────────────────

function generateHtml(dateLabels, data) {
  const { datasets, dailyTotals, avg7, totalSuccess, totalFail, errorRate } = data;
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const tableRows = dateLabels.map((d, i) => {
    const total = dailyTotals[i];
    const statusClass = total >= 15 ? 'green' : total >= 10 ? 'yellow' : 'red';
    const statusMark = total >= 15 ? '✅' : total >= 10 ? '⚠️' : '❌';
    const cols = datasets.map(ds => `<td>${ds.data[i]}</td>`).join('');
    return `<tr>
      <td>${d}</td>
      ${cols}
      <td><span class="${statusClass}">${statusMark} ${total}</span></td>
    </tr>`;
  }).reverse().join('\n');

  const chartData = JSON.stringify({
    labels: dateLabels,
    datasets: datasets.map(ds => ({
      label: ds.label,
      data: ds.data,
      backgroundColor: ds.bg,
      borderColor: ds.border,
      borderWidth: 2,
    })),
  });

  return `<!DOCTYPE html>
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
  <p style="color:#888; font-size:13px;">最終更新: ${generatedAt}</p>

  <div class="cards">
    <div class="card">
      <div class="label">直近7日平均</div>
      <div class="value ${avg7 >= 15 ? 'green' : avg7 >= 10 ? 'yellow' : 'red'}">${avg7}</div>
    </div>
    <div class="card">
      <div class="label">総成功投稿</div>
      <div class="value green">${totalSuccess}</div>
    </div>
    <div class="card">
      <div class="label">総失敗</div>
      <div class="value ${totalFail === 0 ? 'green' : 'red'}">${totalFail}</div>
    </div>
    <div class="card">
      <div class="label">エラー率</div>
      <div class="value ${errorRate <= 10 ? 'green' : 'red'}">${errorRate}%</div>
    </div>
  </div>

  <div class="chart-box">
    <h2>📊 プラットフォーム別 日次投稿数（直近${dateLabels.length}日）</h2>
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
      data: ${chartData},
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' } },
        scales: {
          x: { stacked: true },
          y: {
            stacked: true, beginAtZero: true,
            ticks: { stepSize: 5 },
          },
        },
      },
    });
  </script>
</body>
</html>`;
}

// ── メイン ───────────────────────────────────────────────────────────

const dateLabels = getDateLabels(DAYS);
const records = loadAnalytics();
const data = aggregate(records, dateLabels);

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, generateHtml(dateLabels, data));

console.log(`✅ ダッシュボード生成完了: ${OUTPUT_FILE}`);
console.log(`   期間: ${dateLabels[0]} 〜 ${dateLabels[dateLabels.length - 1]}`);
console.log(`   直近7日平均投稿数: ${data.avg7}件`);
console.log(`   エラー率: ${data.errorRate}%`);
