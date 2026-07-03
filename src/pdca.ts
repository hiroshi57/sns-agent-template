/**
 * PDCA CLI エントリポイント
 *
 * 使い方:
 *   npm run pdca:analyze           KPI 分析 → 戦略更新
 *   npm run pdca:analyze -- --dry-run   戦略を保存せずに分析のみ
 *   npm run pdca:status            現在の KPI と戦略を表示
 *   npm run pdca:reset             戦略をデフォルトにリセット
 */
import 'dotenv/config';
import { runPdcaCycle, printPdcaStatus } from './agents/pdca-controller';
import { saveStrategy, DEFAULT_STRATEGY } from './utils/strategy-store';
import { printKpiDisplay } from './utils/kpi-display';
import { logger } from './utils/logger';

const args = process.argv.slice(2);
const cmd     = args[0] ?? 'analyze';
const dryRun  = args.includes('--dry-run');
const days    = parseInt(args.find((a) => a.startsWith('--days='))?.split('=')[1] ?? '7', 10);

(async () => {
  switch (cmd) {
    case 'analyze': {
      logger.info(`PDCA 分析開始 (window=${days}日, dryRun=${dryRun})`);
      const { strategy, report } = await runPdcaCycle({ windowDays: days, dryRun });
      if (report.allTargetsMet) {
        logger.info('🎉 全 KPI 達成。おめでとうございます！');
        process.exit(0);
      }
      logger.info(`次のサイクルで適用される戦略 v${strategy.version} を保存しました。`);
      break;
    }

    case 'status': {
      // KPI ダッシュボード（C-3: slot-summary + avgImp トレンド表示）
      printKpiDisplay(days);
      // PDCA 戦略詳細
      printPdcaStatus();
      break;
    }

    case 'reset': {
      saveStrategy({ ...DEFAULT_STRATEGY, updatedAt: new Date().toISOString() });
      logger.info('戦略をデフォルトにリセットしました。');
      break;
    }

    default: {
      console.log(`
使い方:
  npm run pdca:analyze            KPI 分析 → 戦略更新
  npm run pdca:analyze -- --dry-run  保存せずに分析のみ
  npm run pdca:analyze -- --days=14  分析ウィンドウを 14 日に変更
  npm run pdca:status             現在の KPI と戦略を表示
  npm run pdca:reset              戦略をデフォルトにリセット
      `);
    }
  }
})().catch((err) => {
  logger.error(`PDCA エラー: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
