/**
 * KPI コレクター
 *
 * x-analytics.jsonl + x-slot-summary.jsonl を読み込み、
 * PDCA 戦略分析に必要な KpiReport を生成する。
 *
 * 集計対象 KPI:
 *   - 投稿数（スロット別・日別）
 *   - エラー数・エラー率
 *   - スキップ数・スキップ率（意見フィルタ + キャッシュ）
 *   - カテゴリー数（週あたり有効カテゴリ数）
 *   - カテゴリーバランス（偏り指数）
 *   - スロット別稼働率
 */
import { readAnalyticsRecords, readSlotSummaries, SlotRunSummary, AnalyticsRecord } from '../utils/analytics-logger';
import { KpiTargets, ContentStrategy } from '../utils/strategy-store';
import { SlotName, XCategory, X_CATEGORIES } from '../utils/x-category';

// ----------------------------------------------------------------
// 型定義
// ----------------------------------------------------------------

export interface SlotKpi {
  slot: SlotName;
  runs: number;            // 実行回数
  postsSucceeded: number;
  postsErrored: number;
  postsSkipped: number;
  successRate: number;     // 0.0–1.0
  errorRate: number;
  skipRate: number;
  avgBatchSize: number;
  categoriesUsed: XCategory[];
}

export interface KpiReport {
  generatedAt: string;
  windowDays: number;

  // ── 全体集計 ──
  totalRuns: number;
  totalPosts: number;       // 成功
  totalErrors: number;
  totalSkips: number;
  overallSuccessRate: number;
  overallErrorRate: number;
  overallSkipRate: number;

  // ── スロット別 ──
  bySlot: Record<SlotName, SlotKpi>;

  // ── カテゴリー集計 ──
  categoriesUsed: XCategory[];          // 期間中に使われたカテゴリ
  categoriesUnused: XCategory[];        // 使われなかったカテゴリ
  categoryDistribution: Record<string, number>; // カテゴリ → 投稿数
  /** バランス指数: 各カテゴリの標準偏差を平均で割った値。0 が完全均等、高いほど偏り大 */
  categoryImbalanceScore: number;
  /** 最も過剰なカテゴリ TOP3 */
  overrepresentedCategories: XCategory[];
  /** 最も不足しているカテゴリ TOP3 */
  underrepresentedCategories: XCategory[];

  // ── KPI 目標達成状況 ──
  targetsStatus: {
    dailyPosts:    { target: number; actual: number; met: boolean };
    errorRate:     { target: number; actual: number; met: boolean };
    skipRate:      { target: number; actual: number; met: boolean };
    categoryCount: { target: number; actual: number; met: boolean };
  };
  allTargetsMet: boolean;
}

// ----------------------------------------------------------------
// メイン関数
// ----------------------------------------------------------------

export function collectKpis(
  strategy: ContentStrategy,
  windowDays = 7
): KpiReport {
  const summaries = readSlotSummaries(windowDays);
  const records   = readAnalyticsRecords(windowDays);
  const targets   = strategy.targets;

  // ── スロット別集計 ──
  const slotNames: SlotName[] = ['slot07', 'slot11', 'slot12', 'slot14', 'slot17'];
  const bySlot = {} as Record<SlotName, SlotKpi>;

  for (const slot of slotNames) {
    const slotSummaries = summaries.filter((s) => s.slot === slot);
    const runs = slotSummaries.length;

    const postsSucceeded = slotSummaries.reduce((a, s) => a + s.succeeded, 0);
    const postsErrored   = slotSummaries.reduce((a, s) => a + s.errored,   0);
    const postsSkipped   = slotSummaries.reduce(
      (a, s) => a + s.opinionSkipped + s.cacheSkipped, 0
    );
    const totalAttempted = postsSucceeded + postsErrored;
    const avgBatchSize   = runs > 0
      ? slotSummaries.reduce((a, s) => a + s.batchSize, 0) / runs
      : 0;

    const categoriesUsedSet = new Set<XCategory>();
    slotSummaries.forEach((s) => s.categoriesUsed.forEach((c) => categoriesUsedSet.add(c)));

    bySlot[slot] = {
      slot,
      runs,
      postsSucceeded,
      postsErrored,
      postsSkipped,
      successRate: totalAttempted > 0 ? postsSucceeded / totalAttempted : 0,
      errorRate:   totalAttempted > 0 ? postsErrored   / totalAttempted : 0,
      skipRate: (postsSucceeded + postsErrored + postsSkipped) > 0
        ? postsSkipped / (postsSucceeded + postsErrored + postsSkipped) : 0,
      avgBatchSize,
      categoriesUsed: [...categoriesUsedSet],
    };
  }

  // ── 全体集計 ──
  const totalPosts  = Object.values(bySlot).reduce((a, s) => a + s.postsSucceeded, 0);
  const totalErrors = Object.values(bySlot).reduce((a, s) => a + s.postsErrored,   0);
  const totalSkips  = Object.values(bySlot).reduce((a, s) => a + s.postsSkipped,   0);
  const totalAttempted = totalPosts + totalErrors;

  // ── カテゴリー集計 ──
  const catDist: Record<string, number> = {};
  for (const r of records.filter((r) => r.success)) {
    catDist[r.theme] = (catDist[r.theme] ?? 0) + 1;
  }

  const categoriesUsed    = X_CATEGORIES.filter((c) => (catDist[c] ?? 0) > 0);
  const categoriesUnused  = X_CATEGORIES.filter((c) => !(catDist[c] ?? 0));

  // バランス指数（全カテゴリの投稿数の変動係数）
  const counts = X_CATEGORIES.map((c) => catDist[c] ?? 0);
  const mean   = counts.reduce((a, b) => a + b, 0) / counts.length;
  const std    = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
  const categoryImbalanceScore = mean > 0 ? std / mean : 0;

  // 過剰・不足カテゴリ
  const sorted = [...X_CATEGORIES].sort((a, b) => (catDist[b] ?? 0) - (catDist[a] ?? 0));
  const overrepresentedCategories  = sorted.slice(0, 3);
  const underrepresentedCategories = [...sorted].reverse().slice(0, 3);

  // ── 日別平均投稿数（5スロット合計） ──
  const dateSet = new Set(summaries.map((s) => s.date));
  const avgDailyPosts = dateSet.size > 0 ? totalPosts / dateSet.size : 0;

  // ── KPI 目標達成チェック ──
  const targetsStatus = {
    dailyPosts: {
      target: targets.dailyPostsMin,
      actual: Math.round(avgDailyPosts * 10) / 10,
      met:    avgDailyPosts >= targets.dailyPostsMin,
    },
    errorRate: {
      target: targets.errorRateMax,
      actual: totalAttempted > 0 ? Math.round((totalErrors / totalAttempted) * 1000) / 1000 : 0,
      met:    totalAttempted === 0 || (totalErrors / totalAttempted) <= targets.errorRateMax,
    },
    skipRate: {
      target: targets.skipRateMax,
      actual: (totalPosts + totalErrors + totalSkips) > 0
        ? Math.round((totalSkips / (totalPosts + totalErrors + totalSkips)) * 1000) / 1000
        : 0,
      met: (totalPosts + totalErrors + totalSkips) === 0 ||
        totalSkips / (totalPosts + totalErrors + totalSkips) <= targets.skipRateMax,
    },
    categoryCount: {
      target: targets.weeklyCategoriesMin,
      actual: categoriesUsed.length,
      met:    categoriesUsed.length >= targets.weeklyCategoriesMin,
    },
  };

  const allTargetsMet = Object.values(targetsStatus).every((t) => t.met);

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    totalRuns: summaries.length,
    totalPosts,
    totalErrors,
    totalSkips,
    overallSuccessRate: totalAttempted > 0 ? totalPosts / totalAttempted : 0,
    overallErrorRate:   totalAttempted > 0 ? totalErrors / totalAttempted : 0,
    overallSkipRate: (totalPosts + totalErrors + totalSkips) > 0
      ? totalSkips / (totalPosts + totalErrors + totalSkips) : 0,
    bySlot,
    categoriesUsed,
    categoriesUnused,
    categoryDistribution: catDist,
    categoryImbalanceScore,
    overrepresentedCategories,
    underrepresentedCategories,
    targetsStatus,
    allTargetsMet,
  };
}

/** KpiReport を人が読めるテキストに変換（ログ出力用） */
export function formatKpiReport(report: KpiReport): string {
  const lines: string[] = [
    `\n${'='.repeat(60)}`,
    `KPI レポート (直近 ${report.windowDays} 日間) — ${new Date(report.generatedAt).toLocaleString('ja-JP')}`,
    `${'='.repeat(60)}`,
    `📊 全体`,
    `  実行スロット数: ${report.totalRuns}`,
    `  投稿成功: ${report.totalPosts} 件  エラー: ${report.totalErrors} 件  スキップ: ${report.totalSkips} 件`,
    `  成功率: ${(report.overallSuccessRate * 100).toFixed(1)}%  エラー率: ${(report.overallErrorRate * 100).toFixed(1)}%  スキップ率: ${(report.overallSkipRate * 100).toFixed(1)}%`,
    ``,
    `📅 スロット別`,
  ];
  for (const slot of ['slot07', 'slot11', 'slot12', 'slot14', 'slot17'] as SlotName[]) {
    const s = report.bySlot[slot];
    lines.push(
      `  ${slot}: 実行 ${s.runs} 回  成功 ${s.postsSucceeded}  エラー ${s.postsErrored}  スキップ ${s.postsSkipped}  バッチ平均 ${s.avgBatchSize.toFixed(1)}`
    );
  }
  lines.push(
    ``,
    `🎯 カテゴリー`,
    `  有効: ${report.categoriesUsed.length} / 20  偏り指数: ${report.categoryImbalanceScore.toFixed(2)}`,
    `  未使用: ${report.categoriesUnused.join(', ') || 'なし'}`,
    `  過剰 TOP3: ${report.overrepresentedCategories.join(', ')}`,
    `  不足 TOP3: ${report.underrepresentedCategories.join(', ')}`,
    ``,
    `✅ KPI 目標達成状況`,
  );
  for (const [key, v] of Object.entries(report.targetsStatus)) {
    lines.push(`  ${v.met ? '✅' : '❌'} ${key}: 目標 ${v.target}  実績 ${v.actual}`);
  }
  lines.push(
    ``,
    `総合: ${report.allTargetsMet ? '✅ 全KPI達成！' : '❌ 未達成あり → PDCA 継続'}`,
    `${'='.repeat(60)}`,
  );
  return lines.join('\n');
}
