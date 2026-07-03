/**
 * KPI ダッシュボード表示ユーティリティ
 *
 * slot-summary と analytics から KPI を読み込んで
 * コンソールに見やすく表示する。
 *
 * PDCA 初回確認 (C-1) + ダッシュボード KPI 拡充 (C-3) の実装。
 *
 * 使い方:
 *   ts-node src/utils/kpi-display.ts
 *   または pdca:status スクリプトから参照
 */

import { readAnalyticsRecords, readSlotSummaries, SlotRunSummary, AnalyticsRecord } from './analytics-logger';
import { logger } from './logger';
import { SlotName } from './x-category';

// ── KPI 目標値（CLAUDE.md と統一） ──────────────────────────────────
const KPI_TARGETS = {
  dailyPostsMin: 15,
  errorRateMax: 0.10,
  skipRateMax: 0.20,
  weeklyCategoriesMin: 14,
  avgImpMin: 60,  // targetImpPerDay = 1ツイートあたり平均インプレッション目標
};

// ─────────────────────────────────────────────
// avgImp 計算（analytics から）
// ─────────────────────────────────────────────

/**
 * x-analytics.jsonl の直近 windowDays 日分から avgImp を計算する。
 * インプレッション数は X API 連携がないため現時点では推定値（投稿成功数をプロキシ）。
 * X API 連携後は record.impressions を使用する。
 */
export function calculateAvgImp(records: AnalyticsRecord[]): {
  avgImp: number | null;
  totalPosts: number;
  successPosts: number;
  note: string;
} {
  const successRecords = records.filter((r) => r.success);
  const totalPosts = records.length;
  const successPosts = successRecords.length;

  // X API 未連携: インプレッションデータなし
  // analytics に impressions フィールドがある場合は集計する（将来の拡張）
  const withImp = successRecords.filter(
    (r) => typeof (r as { impressions?: number }).impressions === 'number'
  );

  if (withImp.length === 0) {
    return {
      avgImp: null,
      totalPosts,
      successPosts,
      note: 'X API 未連携 — impressions データなし（x:analytics コマンドで取得可能）',
    };
  }

  const totalImp = withImp.reduce(
    (sum, r) => sum + ((r as { impressions?: number }).impressions ?? 0),
    0
  );
  return {
    avgImp: Math.round(totalImp / withImp.length),
    totalPosts,
    successPosts,
    note: `${withImp.length}件のインプレッションデータから集計`,
  };
}

// ─────────────────────────────────────────────
// スロット別サマリー
// ─────────────────────────────────────────────

export interface SlotStats {
  slot: SlotName;
  runs: number;
  succeeded: number;
  errored: number;
  successRate: number;
  categoriesUsed: string[];
}

export function calculateSlotStats(summaries: SlotRunSummary[]): SlotStats[] {
  const slots: SlotName[] = ['slot07', 'slot11', 'slot12', 'slot14', 'slot17'];
  return slots.map((slot) => {
    const slotSummaries = summaries.filter((s) => s.slot === slot);
    const runs = slotSummaries.length;
    const succeeded = slotSummaries.reduce((a, s) => a + s.succeeded, 0);
    const errored = slotSummaries.reduce((a, s) => a + s.errored, 0);
    const total = succeeded + errored;
    const catSet = new Set<string>();
    slotSummaries.forEach((s) => s.categoriesUsed.forEach((c) => catSet.add(c)));

    return {
      slot,
      runs,
      succeeded,
      errored,
      successRate: total > 0 ? succeeded / total : 0,
      categoriesUsed: [...catSet],
    };
  });
}

// ─────────────────────────────────────────────
// 日別投稿数トレンド
// ─────────────────────────────────────────────

export interface DailyTrend {
  date: string;
  succeeded: number;
  errored: number;
}

export function calculateDailyTrend(summaries: SlotRunSummary[]): DailyTrend[] {
  const byDate = new Map<string, DailyTrend>();
  for (const s of summaries) {
    if (!byDate.has(s.date)) {
      byDate.set(s.date, { date: s.date, succeeded: 0, errored: 0 });
    }
    const entry = byDate.get(s.date)!;
    entry.succeeded += s.succeeded;
    entry.errored += s.errored;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ─────────────────────────────────────────────
// メイン表示関数
// ─────────────────────────────────────────────

/**
 * KPI サマリーをログに出力する。
 * pdca:status コマンドや pdca-controller.ts から呼ぶ。
 */
export function printKpiDisplay(windowDays = 7): void {
  const summaries = readSlotSummaries(windowDays);
  const records   = readAnalyticsRecords(windowDays);

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`📊 KPI ダッシュボード（直近 ${windowDays} 日）`);
  logger.info(`${'═'.repeat(60)}`);

  // ── 全体集計 ──
  const totalSucceeded = summaries.reduce((a, s) => a + s.succeeded, 0);
  const totalErrored   = summaries.reduce((a, s) => a + s.errored,   0);
  const totalAttempted = totalSucceeded + totalErrored;
  const dates = [...new Set(summaries.map((s) => s.date))];
  const avgDaily = dates.length > 0 ? Math.round(totalSucceeded / dates.length) : 0;
  const errorRate = totalAttempted > 0 ? totalErrored / totalAttempted : 0;

  const catSet = new Set<string>();
  summaries.forEach((s) => s.categoriesUsed.forEach((c) => catSet.add(c)));
  const categoryCount = catSet.size;

  logger.info('\n【全体】');
  logger.info(`  総投稿成功: ${totalSucceeded} 件 / エラー: ${totalErrored} 件`);
  logger.info(`  日次平均:   ${avgDaily} 件/日 ${avgDaily >= KPI_TARGETS.dailyPostsMin ? '✅' : '❌'} (目標 ${KPI_TARGETS.dailyPostsMin}件)`);
  logger.info(`  エラー率:   ${(errorRate * 100).toFixed(1)}% ${errorRate <= KPI_TARGETS.errorRateMax ? '✅' : '❌'} (目標 ≤${KPI_TARGETS.errorRateMax * 100}%)`);
  logger.info(`  カテゴリ:   ${categoryCount}/20 種 ${categoryCount >= KPI_TARGETS.weeklyCategoriesMin ? '✅' : '❌'} (目標 ≥${KPI_TARGETS.weeklyCategoriesMin})`);
  logger.info(`  集計期間:   ${dates.length} 日間 (${dates[0] ?? 'N/A'} 〜 ${dates[dates.length - 1] ?? 'N/A'})`);

  // ── avgImp ──
  const impResult = calculateAvgImp(records);
  logger.info('\n【インプレッション】');
  if (impResult.avgImp !== null) {
    logger.info(`  avgImp/tweet: ${impResult.avgImp} ${impResult.avgImp >= KPI_TARGETS.avgImpMin ? '✅' : '❌'} (目標 ≥${KPI_TARGETS.avgImpMin})`);
  } else {
    logger.info(`  avgImp/tweet: 測定中 — ${impResult.note}`);
  }
  logger.info(`  総投稿: ${impResult.totalPosts}件 (成功 ${impResult.successPosts}件)`);

  // ── スロット別 ──
  logger.info('\n【スロット別】');
  const slotStats = calculateSlotStats(summaries);
  for (const s of slotStats) {
    if (s.runs === 0) continue;
    const bar = '█'.repeat(Math.round(s.successRate * 10));
    logger.info(`  ${s.slot}: ${s.succeeded}成功/${s.errored}エラー (${(s.successRate * 100).toFixed(0)}%) ${bar}`);
  }

  // ── 日別トレンド ──
  const trend = calculateDailyTrend(summaries);
  if (trend.length > 0) {
    logger.info('\n【日別投稿数トレンド（直近）】');
    const recent = trend.slice(-7); // 直近7日
    for (const d of recent) {
      const bar = '▓'.repeat(Math.min(d.succeeded, 20));
      const status = d.succeeded >= KPI_TARGETS.dailyPostsMin ? '✅' : '❌';
      logger.info(`  ${d.date}: ${d.succeeded.toString().padStart(2)} 件 ${bar} ${status}`);
    }
  }

  // ── カテゴリ一覧 ──
  if (catSet.size > 0) {
    logger.info(`\n【使用カテゴリ (${catSet.size}/20)】`);
    logger.info(`  ${[...catSet].join(', ')}`);
  }

  logger.info(`\n${'═'.repeat(60)}\n`);
}

// ─────────────────────────────────────────────
// CLI 直接実行
// ─────────────────────────────────────────────

if (require.main === module) {
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;
  printKpiDisplay(days);
}
