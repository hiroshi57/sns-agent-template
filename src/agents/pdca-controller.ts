/**
 * PDCA コントローラー
 *
 * PDCA ループを司るオーケストレーター。
 *   Plan  → loadStrategy() で現在の戦略を読み込む
 *   Do    → index-x.ts の runSlot() が担当（このファイルは呼ばない）
 *   Check → collectKpis() で KpiReport を生成
 *   Act   → analyzeAndUpdateStrategy() で戦略を更新・保存
 *
 * 停止条件: strategy.kpiAchieved === true または --max-cycles 到達
 */
import Anthropic from '@anthropic-ai/sdk';
import { collectKpis, formatKpiReport, KpiReport } from './kpi-collector';
import { analyzeAndUpdateStrategy } from './strategy-analyzer';
import { loadStrategy, saveStrategy, ContentStrategy } from '../utils/strategy-store';
import { sendKpiAlert } from '../utils/alert-notifier';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

const PDCA_LOG_FILE = path.join(process.cwd(), 'data', 'pdca-history.jsonl');

/** KPI 未達アラートを送る連続失敗閾値（日数） */
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

// ----------------------------------------------------------------
// PDCA ログ
// ----------------------------------------------------------------

interface PdcaCycleLog {
  cycleAt: string;
  strategyVersion: number;
  kpiSnapshot: {
    totalPosts: number;
    errorRate: number;
    skipRate: number;
    categoriesUsed: number;
    allTargetsMet: boolean;
  };
  insights: string[];
  changedAxes: {
    categoryWeights: number;
    slotThemeOverrides: number;
    sourceBoosts: number;
  };
  problemSummary?: string;
}

function logPdcaCycle(entry: PdcaCycleLog): void {
  try {
    const dir = path.dirname(PDCA_LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(PDCA_LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* ignore */ }
}

/**
 * pdca-history.jsonl の末尾から連続 KPI 未達日数を数える。
 * 1件でも `allTargetsMet === true` が出たらリセット。
 */
function countConsecutiveKpiFailures(): number {
  if (!fs.existsSync(PDCA_LOG_FILE)) return 0;
  const lines = fs.readFileSync(PDCA_LOG_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean);
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as PdcaCycleLog;
      if (entry.kpiSnapshot.allTargetsMet) break; // 達成サイクルでリセット
      count++;
    } catch { break; }
  }
  return count;
}

// ----------------------------------------------------------------
// メイン: 1 PDCA サイクル実行
// ----------------------------------------------------------------

/**
 * PDCA サイクルを 1 回実行する。
 * - KPI 収集 → 分析 → 戦略保存
 * - 戻り値: 更新後の strategy
 */
export async function runPdcaCycle(opts: {
  windowDays?: number;
  dryRun?: boolean;
} = {}): Promise<{ strategy: ContentStrategy; report: KpiReport }> {
  const { windowDays = 7, dryRun = false } = opts;

  const anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] ?? '' });
  const current = loadStrategy();

  logger.info(`\n${'━'.repeat(60)}`);
  logger.info(`PDCA サイクル開始 (strategy v${current.version})`);
  logger.info(`${'━'.repeat(60)}`);

  // ── Check: KPI 収集 ──
  const report = collectKpis(current, windowDays);
  logger.info(formatKpiReport(report));

  if (report.totalRuns === 0) {
    logger.warn('[PDCA] 実行履歴なし。初回投稿後に再実行してください。');
    return { strategy: current, report };
  }

  // ── KPI 達成チェック ──
  if (report.allTargetsMet) {
    logger.info('[PDCA] 🎉 全 KPI 達成！PDCA サイクルを停止します。');
    const updated = { ...current, kpiAchieved: true };
    if (!dryRun) saveStrategy(updated);
    return { strategy: updated, report };
  }

  // ── Act: 戦略分析・更新 ──
  const updated = await analyzeAndUpdateStrategy(anthropic, report, current);

  if (!dryRun) {
    saveStrategy(updated);
    logger.info(`[PDCA] strategy.json 更新 → version ${updated.version}`);
  } else {
    logger.info('[PDCA] DRY-RUN: strategy.json は更新しません');
  }

  // PDCA 履歴ログ
  logPdcaCycle({
    cycleAt: new Date().toISOString(),
    strategyVersion: updated.version,
    kpiSnapshot: {
      totalPosts:    report.totalPosts,
      errorRate:     report.overallErrorRate,
      skipRate:      report.overallSkipRate,
      categoriesUsed: report.categoriesUsed.length,
      allTargetsMet: report.allTargetsMet,
    },
    insights: updated.insights,
    changedAxes: {
      categoryWeights:    Object.keys(updated.categoryWeights).length,
      slotThemeOverrides: Object.keys(updated.slotThemeOverrides).length,
      sourceBoosts:       updated.sourceBoosts.length,
    },
    problemSummary: updated.problemSummary,
  });

  // ── インサイト出力 ──
  logger.info('\n📌 インサイト:');
  updated.insights.forEach((ins, i) => logger.info(`  ${i + 1}. ${ins}`));

  if (updated.problemSummary) {
    logger.info(`\n🔴 問題点: ${updated.problemSummary}`);
  }

  // ── KPI 未達 連続アラート ──
  if (!report.allTargetsMet) {
    // ログ記録後の連続失敗数（今回分を含む）
    const consecutiveFails = countConsecutiveKpiFailures();
    logger.info(`[Alert] KPI 未達 連続 ${consecutiveFails} 日`);

    if (consecutiveFails >= CONSECUTIVE_FAILURE_THRESHOLD) {
      const unmetList = Object.entries(report.targetsStatus)
        .filter(([, v]) => !v.met)
        .map(([k, v]) => `  • ${k}: 目標 ${v.target}  実績 ${v.actual}`)
        .join('\n');

      const alertTitle = `⚠️ [PDCA] KPI 未達 ${consecutiveFails} 日連続`;
      const alertBody = [
        `${new Date().toLocaleString('ja-JP')} 時点`,
        '',
        '【未達 KPI】',
        unmetList,
        '',
        `問題点: ${updated.problemSummary ?? '(なし)'}`,
        '',
        'インサイト:',
        ...updated.insights.slice(0, 3).map((ins) => `  - ${ins}`),
      ].join('\n');

      if (!dryRun) {
        await sendKpiAlert(alertTitle, alertBody).catch((err) => {
          logger.warn(`[Alert] アラート送信失敗: ${err instanceof Error ? err.message : String(err)}`);
        });
      } else {
        logger.info(`[Alert] DRY-RUN: アラート送信をスキップ`);
      }
    }
  }

  return { strategy: updated, report };
}

// ----------------------------------------------------------------
// ステータス表示
// ----------------------------------------------------------------

export function printPdcaStatus(): void {
  const strategy = loadStrategy();
  const report   = collectKpis(strategy);

  logger.info(formatKpiReport(report));

  logger.info('\n📋 現在の戦略');
  logger.info(`  version: ${strategy.version}  updatedAt: ${strategy.updatedAt}`);
  logger.info(`  kpiAchieved: ${strategy.kpiAchieved}`);

  if (Object.keys(strategy.categoryWeights).length > 0) {
    logger.info('\n  カテゴリウェイト:');
    for (const [cat, w] of Object.entries(strategy.categoryWeights)) {
      const bar = '█'.repeat(Math.round(w * 5));
      logger.info(`    ${cat.padEnd(20)} ${w.toFixed(1)} ${bar}`);
    }
  }

  if (Object.keys(strategy.slotThemeOverrides).length > 0) {
    logger.info('\n  テーマ上書き:');
    for (const [slot, themes] of Object.entries(strategy.slotThemeOverrides)) {
      logger.info(`    ${slot}: [${themes?.join(', ')}]`);
    }
  }

  if (strategy.insights.length > 0) {
    logger.info('\n  最新インサイト:');
    strategy.insights.forEach((ins, i) => logger.info(`    ${i + 1}. ${ins}`));
  }

  // PDCA 履歴サマリー
  if (fs.existsSync(PDCA_LOG_FILE)) {
    const lines = fs.readFileSync(PDCA_LOG_FILE, 'utf-8')
      .split('\n').filter(Boolean).slice(-5); // 直近5件
    logger.info('\n  PDCA 履歴 (直近5件):');
    lines.forEach((l) => {
      try {
        const entry = JSON.parse(l) as PdcaCycleLog;
        const dt = new Date(entry.cycleAt).toLocaleString('ja-JP');
        logger.info(
          `    [${dt}] v${entry.strategyVersion} 投稿${entry.kpiSnapshot.totalPosts}件` +
          ` エラー${(entry.kpiSnapshot.errorRate * 100).toFixed(1)}%` +
          ` カテゴリ${entry.kpiSnapshot.categoriesUsed}/20` +
          ` ${entry.kpiSnapshot.allTargetsMet ? '✅達成' : '❌未達'}`
        );
      } catch { /* ignore */ }
    });
  }
}
