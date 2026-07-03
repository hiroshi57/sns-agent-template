#!/usr/bin/env node
/**
 * PDCA Step Summary ジェネレーター (#26)
 *
 * pdca-history.jsonl を読み込み、GitHub Actions Step Summary 形式の
 * Markdown（KPI トレンドテーブル + Mermaid グラフ）を生成する。
 *
 * 使い方:
 *   node scripts/pdca-summary.js >> $GITHUB_STEP_SUMMARY
 */
const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(process.cwd(), 'data', 'pdca-history.jsonl');
const STRATEGY_FILE = path.join(process.cwd(), 'data', 'strategy.json');

// ── データ読み込み ──────────────────────────────────────────────────
function loadHistory(maxEntries = 14) {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return fs.readFileSync(HISTORY_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .slice(-maxEntries);
}

function loadStrategy() {
  if (!fs.existsSync(STRATEGY_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf-8')); } catch { return null; }
}

// ── Mermaid xychart-beta ───────────────────────────────────────────
function buildMermaidChart(entries) {
  if (entries.length === 0) return '';

  const labels = entries.map((e) => {
    const d = new Date(e.cycleAt);
    return `"${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}"`;
  });

  const posts   = entries.map((e) => e.kpiSnapshot.totalPosts);
  const errPct  = entries.map((e) => Math.round(e.kpiSnapshot.errorRate * 1000) / 10);
  const catNums = entries.map((e) => e.kpiSnapshot.categoriesUsed);

  return [
    '```mermaid',
    'xychart-beta',
    '  title "PDCA KPI トレンド（直近 14 サイクル）"',
    `  x-axis [${labels.join(', ')}]`,
    '  y-axis "投稿数 / カテゴリ数" 0 --> 25',
    `  bar [${posts.join(', ')}]`,
    `  line [${catNums.join(', ')}]`,
    '```',
    '',
    '> 棒グラフ: 投稿成功数　折れ線: 有効カテゴリ数',
    '',
  ].join('\n');
}

// ── KPI テーブル ──────────────────────────────────────────────────
function buildKpiTable(entries) {
  const header = [
    '| 日付 | バージョン | 投稿数 | エラー率 | スキップ率 | カテゴリ | 結果 |',
    '|------|-----------|--------|---------|-----------|--------|------|',
  ];
  const rows = entries.slice(-7).map((e) => {
    const d = new Date(e.cycleAt).toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' });
    const errPct = (e.kpiSnapshot.errorRate * 100).toFixed(1) + '%';
    const skipPct = (e.kpiSnapshot.skipRate * 100).toFixed(1) + '%';
    const result = e.kpiSnapshot.allTargetsMet ? '✅ 達成' : '❌ 未達';
    return `| ${d} | v${e.strategyVersion} | ${e.kpiSnapshot.totalPosts} 件 | ${errPct} | ${skipPct} | ${e.kpiSnapshot.categoriesUsed}/20 | ${result} |`;
  });
  return [...header, ...rows].join('\n') + '\n';
}

// ── インサイト・問題点 ────────────────────────────────────────────
function buildInsightSection(strategy) {
  if (!strategy) return '';
  const lines = ['### 📌 直近インサイト\n'];
  if (strategy.insights?.length > 0) {
    strategy.insights.slice(0, 3).forEach((ins, i) => lines.push(`${i + 1}. ${ins}`));
  } else {
    lines.push('(なし)');
  }
  if (strategy.problemSummary) {
    lines.push('', `> 🔴 **問題点**: ${strategy.problemSummary}`);
  }
  return lines.join('\n') + '\n';
}

// ── メイン ───────────────────────────────────────────────────────
function main() {
  const entries  = loadHistory(14);
  const strategy = loadStrategy();

  const lines = [
    '## 📊 PDCA KPI サマリー\n',
  ];

  if (entries.length === 0) {
    lines.push('> PDCA 実行履歴がありません。初回投稿後に再実行してください。\n');
  } else {
    // 最新状態バッジ
    const latest = entries[entries.length - 1];
    const badge = latest.kpiSnapshot.allTargetsMet
      ? '![KPI達成](https://img.shields.io/badge/KPI-達成-brightgreen)'
      : '![KPI未達](https://img.shields.io/badge/KPI-未達-red)';
    lines.push(badge, '');

    // Mermaid グラフ
    lines.push(buildMermaidChart(entries));

    // KPI テーブル（直近7件）
    lines.push('### 📅 KPI 履歴（直近 7 サイクル）\n');
    lines.push(buildKpiTable(entries));

    // 連続失敗カウント
    let consecutiveFails = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].kpiSnapshot.allTargetsMet) break;
      consecutiveFails++;
    }
    if (consecutiveFails > 0) {
      lines.push(`> ⚠️ **KPI 未達 ${consecutiveFails} 日連続**\n`);
    }
  }

  // インサイト
  if (strategy) {
    lines.push(buildInsightSection(strategy));

    // カテゴリウェイト（設定済みの場合）
    const weights = strategy.categoryWeights ?? {};
    const modifiedWeights = Object.entries(weights).filter(([, w]) => w !== 1.0);
    if (modifiedWeights.length > 0) {
      lines.push('### ⚖️ カテゴリウェイト調整\n');
      lines.push('| カテゴリ | ウェイト | 評価 |');
      lines.push('|---------|---------|------|');
      modifiedWeights.sort((a, b) => b[1] - a[1]).forEach(([cat, w]) => {
        const eval_  = w >= 1.5 ? '🔼 強化' : w <= 0.5 ? '🔽 抑制' : '→ 微調整';
        lines.push(`| ${cat} | ${w.toFixed(1)} | ${eval_} |`);
      });
      lines.push('');
    }

    lines.push(
      `---`,
      `> strategy v${strategy.version}  最終更新: ${new Date(strategy.updatedAt).toLocaleString('ja-JP')}`,
    );
  }

  process.stdout.write(lines.join('\n') + '\n');
}

main();
