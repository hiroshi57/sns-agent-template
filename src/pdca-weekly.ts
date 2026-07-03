/**
 * PDCA 週次サマリーレポート (#24)
 *
 * 毎週月曜日に直近7日間の KPI サマリーを
 * LINE / Slack / Discord に送信する。
 *
 * 使い方:
 *   npm run pdca:weekly          # 送信
 *   npm run pdca:weekly -- --dry-run  # 送信せず内容確認のみ
 */
import 'dotenv/config';
import { collectKpis, formatKpiReport } from './agents/kpi-collector';
import { loadStrategy } from './utils/strategy-store';
import { sendKpiAlert } from './utils/alert-notifier';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  logger.info('=== PDCA 週次サマリーレポート 生成開始 ===');

  const strategy = loadStrategy();
  const report = collectKpis(strategy, 7);

  // ── サマリー本文 ──
  const kpiLines: string[] = [];

  // KPI 目標達成状況
  const { dailyPosts, errorRate, skipRate, categoryCount } = report.targetsStatus;
  kpiLines.push(
    `📊 直近7日間 KPI サマリー`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📅 集計期間: 直近 ${report.windowDays} 日 / ${new Date(report.generatedAt).toLocaleDateString('ja-JP')} 時点`,
    ``,
    `【投稿実績】`,
    `  成功: ${report.totalPosts} 件  エラー: ${report.totalErrors} 件  スキップ: ${report.totalSkips} 件`,
    `  成功率: ${(report.overallSuccessRate * 100).toFixed(1)}%`,
    ``,
    `【KPI 達成状況】`,
    `  ${dailyPosts.met ? '✅' : '❌'} 日次投稿数: 目標 ${dailyPosts.target} 件 → 実績 ${dailyPosts.actual} 件`,
    `  ${errorRate.met ? '✅' : '❌'} エラー率: 目標 ≤${(errorRate.target * 100).toFixed(0)}% → 実績 ${(errorRate.actual * 100).toFixed(1)}%`,
    `  ${skipRate.met ? '✅' : '❌'} スキップ率: 目標 ≤${(skipRate.target * 100).toFixed(0)}% → 実績 ${(skipRate.actual * 100).toFixed(1)}%`,
    `  ${categoryCount.met ? '✅' : '❌'} カテゴリ数: 目標 ${categoryCount.target} 種 → 実績 ${categoryCount.actual} 種`,
    ``,
    `【総合判定】 ${report.allTargetsMet ? '✅ 全 KPI 達成！' : '❌ 未達項目あり → PDCA 継続'}`,
    ``,
    `【スロット別】`,
    ...(['slot07','slot11','slot12','slot14','slot17'] as const).map((slot) => {
      const s = report.bySlot[slot];
      if (s.runs === 0) return `  ${slot}: 未実行`;
      return (
        `  ${slot}: 成功${s.postsSucceeded} エラー${s.postsErrored} スキップ${s.postsSkipped}` +
        ` (成功率 ${(s.successRate * 100).toFixed(0)}%)`
      );
    }),
    ``,
    `【カテゴリー】`,
    `  有効: ${report.categoriesUsed.length}/20  偏り指数: ${report.categoryImbalanceScore.toFixed(2)}`,
    ...(report.categoriesUnused.length > 0
      ? [`  未使用: ${report.categoriesUnused.join(', ')}`]
      : [`  未使用: なし`]),
  );

  // 最新インサイト
  if (strategy.insights.length > 0) {
    kpiLines.push(
      ``,
      `【最新 PDCA インサイト】`,
      ...strategy.insights.slice(0, 3).map((ins, i) => `  ${i + 1}. ${ins}`),
    );
  }

  // 問題点サマリー
  if (strategy.problemSummary) {
    kpiLines.push(
      ``,
      `【問題点】`,
      `  ${strategy.problemSummary}`,
    );
  }

  kpiLines.push(
    ``,
    `戦略 version: ${strategy.version}  最終更新: ${new Date(strategy.updatedAt).toLocaleDateString('ja-JP')}`,
  );

  const title = report.allTargetsMet
    ? '✅ 週次 KPI レポート：全目標達成'
    : `⚠️ 週次 KPI レポート：${Object.values(report.targetsStatus).filter(v => !v.met).length} 項目未達`;
  const body = kpiLines.join('\n');

  logger.info('\n' + formatKpiReport(report));
  logger.info('\n--- 送信内容プレビュー ---');
  logger.info(`${title}\n${body}`);
  logger.info('-------------------------');

  if (dryRun) {
    logger.info('[DRY-RUN] 通知を送信しません');
    process.exit(0);
  }

  await sendKpiAlert(title, body);
  logger.info('=== 週次レポート 送信完了 ===');
}

main().catch((err) => {
  logger.error(`週次レポートエラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
