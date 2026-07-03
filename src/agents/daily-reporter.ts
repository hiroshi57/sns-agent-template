/**
 * daily-reporter.ts
 *
 * 日次レポートエージェント
 * x-analytics.jsonl + x-slot-summary.jsonl を集計して
 * memory/daily-report.md を生成する。
 *
 * 使い方:
 *   npm run daily:report          → 今日の分を生成
 *   npm run daily:report -- --days=3  → 過去3日分を集計
 */

import fs from 'fs';
import path from 'path';
import { readSlotSummaries, readAnalyticsRecords } from '../utils/analytics-logger';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────

interface DailyStats {
  date: string;
  totalPosts: number;
  successPosts: number;
  errorPosts: number;
  slotsRun: string[];
  categoriesUsed: string[];
  categoryCount: number;
  opinionSkipped: number;
  cacheSkipped: number;
  avgTweetLength: number;
  sourceCounts: Record<string, number>;
  dryRunCount: number;
}

// ─────────────────────────────────────────────
// 集計ロジック
// ─────────────────────────────────────────────

function buildDailyStats(windowDays: number): DailyStats[] {
  const summaries = readSlotSummaries(windowDays);
  const analytics = readAnalyticsRecords(windowDays);

  // 日付ごとにグループ化
  const byDate = new Map<string, DailyStats>();

  for (const s of summaries) {
    if (!byDate.has(s.date)) {
      byDate.set(s.date, {
        date: s.date,
        totalPosts: 0,
        successPosts: 0,
        errorPosts: 0,
        slotsRun: [],
        categoriesUsed: [],
        categoryCount: 0,
        opinionSkipped: 0,
        cacheSkipped: 0,
        avgTweetLength: 0,
        sourceCounts: {},
        dryRunCount: 0,
      });
    }
    const d = byDate.get(s.date)!;
    if (!d.slotsRun.includes(s.slot)) d.slotsRun.push(s.slot);
    d.successPosts   += s.succeeded;
    d.errorPosts     += s.errored;
    d.totalPosts     += s.succeeded + s.errored;
    d.opinionSkipped += s.opinionSkipped;
    d.cacheSkipped   += s.cacheSkipped;
    if (s.dryRun) d.dryRunCount++;
    for (const cat of s.categoriesUsed) {
      if (!d.categoriesUsed.includes(cat)) d.categoriesUsed.push(cat);
    }
    d.categoryCount = d.categoriesUsed.length;
  }

  // analytics からツイート長・ソース分布を補完
  for (const a of analytics) {
    const dateStr = a.postedAt.slice(0, 10).replace(/-/g, '/').replace(
      /^(\d{4})\/(\d{2})\/(\d{2})$/, '$1/$2/$3'
    );
    // YYYY-MM-DD → YYYY/MM/DD に変換して突合
    const jstDate = new Date(a.postedAt);
    jstDate.setHours(jstDate.getHours() + 9);
    const jstStr = jstDate.toISOString().slice(0, 10);

    const d = byDate.get(jstStr);
    if (!d) continue;

    d.sourceCounts[a.source] = (d.sourceCounts[a.source] ?? 0) + 1;
    if (a.tweetLength != null) {
      d.avgTweetLength = Math.round(
        (d.avgTweetLength * (d.successPosts - 1) + a.tweetLength) / d.successPosts
      ) || a.tweetLength;
    }
  }

  return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
}

// ─────────────────────────────────────────────
// Markdown レポート生成
// ─────────────────────────────────────────────

function formatReport(stats: DailyStats[], generatedAt: Date): string {
  const lines: string[] = [];
  const dateStr = generatedAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  lines.push(`# X 自動投稿 日次レポート`);
  lines.push(`> 生成日時: ${dateStr}`);
  lines.push('');

  if (stats.length === 0) {
    lines.push('> データなし');
    return lines.join('\n');
  }

  // ── サマリー（全期間合計） ──
  const totalPosts   = stats.reduce((s, d) => s + d.totalPosts, 0);
  const totalSuccess = stats.reduce((s, d) => s + d.successPosts, 0);
  const totalError   = stats.reduce((s, d) => s + d.errorPosts, 0);
  const allCats      = [...new Set(stats.flatMap(d => d.categoriesUsed))];
  const errorRate    = totalPosts > 0 ? Math.round((totalError / totalPosts) * 100) : 0;

  lines.push('## 集計サマリー');
  lines.push('');
  lines.push(`| 指標 | 値 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 集計日数 | ${stats.length} 日 |`);
  lines.push(`| 総投稿数 | ${totalPosts} 件 |`);
  lines.push(`| 成功 | ${totalSuccess} 件 |`);
  lines.push(`| エラー | ${totalError} 件 (${errorRate}%) |`);
  lines.push(`| 使用カテゴリー数 | ${allCats.length} 種 |`);
  lines.push('');

  // KPI 達成状況
  const kpiTargetDaily = 15;
  const kpiTargetCats  = 8;
  const kpiTargetError = 5; // %
  const avgDaily = stats.length > 0 ? Math.round(totalPosts / stats.length) : 0;

  lines.push('## KPI 状況');
  lines.push('');
  lines.push(`| KPI | 目標 | 実績 | 状態 |`);
  lines.push(`|-----|------|------|------|`);
  lines.push(`| 1日あたり投稿数 | ${kpiTargetDaily} 件 | ${avgDaily} 件 | ${avgDaily >= kpiTargetDaily ? '✅ 達成' : '❌ 未達'} |`);
  lines.push(`| カテゴリー種数 | ${kpiTargetCats} 種 | ${allCats.length} 種 | ${allCats.length >= kpiTargetCats ? '✅ 達成' : '❌ 未達'} |`);
  lines.push(`| エラー率 | <${kpiTargetError}% | ${errorRate}% | ${errorRate < kpiTargetError ? '✅ 達成' : '❌ 未達'} |`);
  lines.push('');

  // ── 日別詳細 ──
  lines.push('## 日別詳細');
  lines.push('');

  for (const d of stats) {
    const er = d.totalPosts > 0 ? Math.round((d.errorPosts / d.totalPosts) * 100) : 0;
    const dryTag = d.dryRunCount > 0 ? ' 🔵DRY' : '';

    lines.push(`### ${d.date}${dryTag}`);
    lines.push('');
    lines.push(`- **投稿**: ${d.successPosts} 成功 / ${d.errorPosts} エラー (${er}%)`);
    lines.push(`- **スロット**: ${d.slotsRun.join(', ') || 'なし'}`);
    lines.push(`- **カテゴリー**: ${d.categoriesUsed.join(', ') || 'なし'} (${d.categoryCount} 種)`);
    lines.push(`- **スキップ**: 意見フィルタ ${d.opinionSkipped} 件 / キャッシュ ${d.cacheSkipped} 件`);
    if (d.avgTweetLength > 0) lines.push(`- **平均ツイート長**: ${d.avgTweetLength} 文字`);
    if (Object.keys(d.sourceCounts).length > 0) {
      const srcStr = Object.entries(d.sourceCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      lines.push(`- **ソース内訳**: ${srcStr}`);
    }
    lines.push('');
  }

  // ── 使用カテゴリー一覧 ──
  lines.push('## カテゴリー使用状況');
  lines.push('');
  const catFreq: Record<string, number> = {};
  for (const d of stats) {
    for (const c of d.categoriesUsed) catFreq[c] = (catFreq[c] ?? 0) + 1;
  }
  const sortedCats = Object.entries(catFreq).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedCats) {
    const bar = '█'.repeat(Math.min(count, 10));
    lines.push(`- \`${cat}\`: ${bar} (${count}日)`);
  }
  lines.push('');

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// エントリポイント
// ─────────────────────────────────────────────

export async function generateDailyReport(windowDays = 7): Promise<string> {
  logger.info(`日次レポート生成中 (直近 ${windowDays} 日)...`);

  const stats    = buildDailyStats(windowDays);
  const report   = formatReport(stats, new Date());

  const outDir  = path.join(process.cwd(), 'memory');
  const outFile = path.join(outDir, 'daily-report.md');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, report, 'utf-8');

  logger.info(`日次レポート保存: ${outFile}`);
  return report;
}

// CLI 直接実行
if (require.main === module) {
  const daysArg = process.argv.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;

  generateDailyReport(days)
    .then(report => {
      logger.info(report);
      process.exit(0);
    })
    .catch(err => {
      logger.error(`レポート生成エラー: ${err}`);
      process.exit(1);
    });
}
