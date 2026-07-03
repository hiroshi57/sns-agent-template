/**
 * アダプティブスケーラー（自動投稿量調整）
 *
 * 毎日 23:30 JST（アナリティクス収集の 30 分後）に実行し、
 * KPI 目標（ツイート 1 件あたりの平均インプレッション）と実績を比較して投稿量を自動調整する。
 *
 * ⚠️ targetImpPerDay の意味について：
 *   名前は "PerDay" だが、実際の比較対象は「avgImpressions（1 ツイートあたりの平均 imp）」。
 *   "1日の総インプレッション" ではない。
 *   例: 実績 avg 41 imp/tweet、目標 60 imp/tweet → 未達 → スケールアップ検討。
 *
 * 【スケールアップ条件】
 *   - 直近 2 日連続で目標を下回っている、かつ
 *   - トレンドが横ばいまたは下降（改善の気配がない）
 *   → レベルを 1 段階引き上げ（最大 level 4 まで）
 *
 * 【スケールダウン条件】
 *   - 直近 5 日連続で目標の 120% 以上を達成している
 *   → レベルを 1 段階引き下げ（最小 level 1 まで）
 *   ※ 目標達成中は余分なコストを払わないよう効率化
 *
 * 【調整される投稿量】
 *   level 1 → 2: 引用Bot 1→2件/回, ニュース 2→3件/slot, 意見ツイート +1件, noteCTA +1日
 *   level 2 → 3: 引用Bot 2→3件/回, ニュース 3→4件/slot, noteCTA +1日
 *   level 3 → 4: ニュース 4→5件/slot, 意見ツイート +1件, noteCTA +1日（月〜金毎日）
 *
 * 【目標の段階的引き上げロードマップ】
 *   近期: 60 imp/tweet（現状 ~40 から 50% 改善）
 *   中期: 80 imp/tweet（近期達成後に手動更新）
 *   長期: 100 imp/tweet
 *
 * PM2 cron: '30 14 * * *'（JST 23:30 = UTC 14:30）
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  loadAdaptiveConfig,
  saveAdaptiveConfig,
  SCALE_LEVELS,
  type AdaptiveConfig,
} from '../utils/adaptive-config';
import { logger } from '../utils/logger';

const ANALYTICS_FILE = path.join(process.cwd(), 'data', 'x-analytics-daily.jsonl');

interface DailyAnalytics {
  date: string;
  avgImpressions: number;
  totalImpressions: number;
  count: number;
}

// ── アナリティクス読み込み ────────────────────────────────────────────

function readRecentAnalytics(days: number): DailyAnalytics[] {
  if (!fs.existsSync(ANALYTICS_FILE)) return [];

  const lines = fs.readFileSync(ANALYTICS_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .reverse(); // 新しい順

  const records: DailyAnalytics[] = [];
  for (const line of lines.slice(0, days)) {
    try {
      const r = JSON.parse(line);
      records.push({
        date: r.date,
        avgImpressions: r.avgImpressions ?? 0,
        totalImpressions: r.totalImpressions ?? 0,
        count: r.count ?? 0,
      });
    } catch { /* skip */ }
  }
  return records; // 新しい順のまま返す
}

// ── スケール判定 ──────────────────────────────────────────────────────

type ScaleAction = 'up' | 'down' | 'hold';

function decideAction(
  records: DailyAnalytics[],
  config: AdaptiveConfig,
): { action: ScaleAction; reason: string } {
  if (records.length < 2) {
    return { action: 'hold', reason: 'データ不足（2日分必要）' };
  }

  const target = config.targetImpPerDay;
  const latest = records[0]; // 最新
  const prev = records[1];   // 前日

  const latestAvg = latest.avgImpressions;
  const prevAvg = prev.avgImpressions;

  // ── スケールアップ判断 ──
  // 条件: 最新 2 日が両方とも目標未達 かつ（改善中でない or 未達幅が大きい）
  const bothMiss = latestAvg < target && prevAvg < target;
  const improving = latestAvg > prevAvg * 1.2; // 前日比 20% 以上改善は「改善中」
  const bigGap = latestAvg < target * 0.6;      // 目標の 60% 未満は緊急スケールアップ

  if (config.level < 4 && bothMiss && (!improving || bigGap)) {
    const pct = Math.round((latestAvg / target) * 100);
    return {
      action: 'up',
      reason: `直近 2 日連続で目標未達 (${pct}%): ${prevAvg} → ${latestAvg} imp (目標 ${target})`,
    };
  }

  // ── スケールダウン判断 ──
  // 条件: 直近 5 日が全て目標の 120% 以上を達成している
  if (config.level > 1 && records.length >= 5) {
    const recentFive = records.slice(0, 5);
    const allOverachieving = recentFive.every((r) => r.avgImpressions >= target * 1.2);
    if (allOverachieving) {
      const minAvg = Math.min(...recentFive.map((r) => r.avgImpressions));
      return {
        action: 'down',
        reason: `直近 5 日連続で目標 120% 達成 (最低 ${minAvg} imp): 投稿量を最適化`,
      };
    }
  }

  // ── 現状維持 ──
  if (latestAvg >= target) {
    return { action: 'hold', reason: `目標達成中: ${latestAvg} imp (目標 ${target})` };
  }
  if (improving) {
    return { action: 'hold', reason: `改善中（+${Math.round(((latestAvg - prevAvg) / prevAvg) * 100)}%）のためスケールアップ待機` };
  }
  return { action: 'hold', reason: `様子見: ${latestAvg} imp (目標 ${target})` };
}

// ── メイン ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const forceRun = process.argv.includes('--force') || process.env['FORCE_ADAPTIVE_SCALER'] === 'true';

  logger.info(`=== アダプティブスケーラー起動 (dryRun=${dryRun}) ===`);

  const config = loadAdaptiveConfig();

  // ── 二重実行防止（pm2 再起動の即時トリガーをブロック）──
  // updatedAt から 2 時間以内に再実行されようとしている場合はスキップ。
  // 正規スケジュール（23:30 JST）は pm2 再起動が 2 時間以上前でないと起動しないため問題なし。
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  if (!forceRun && !dryRun && config.updatedAt) {
    const lastRunAt = new Date(config.updatedAt).getTime();
    const elapsed = Date.now() - lastRunAt;
    if (elapsed < TWO_HOURS_MS) {
      const elapsedMin = Math.round(elapsed / 60000);
      logger.info(
        `[adaptive-scaler] 最終実行から ${elapsedMin} 分しか経過していません（level=${config.level}）。スキップします。`,
      );
      logger.info('[adaptive-scaler] 強制実行する場合は --force または FORCE_ADAPTIVE_SCALER=true を使用してください。');
      process.exit(0);
    }
  }

  const records = readRecentAnalytics(7);

  logger.info(`現在のレベル: ${config.level} | 目標: ${config.targetImpPerDay} imp/日`);
  logger.info(`直近データ: ${records.map((r) => `${r.date}=${r.avgImpressions}`).join(', ')}`);

  if (records.length === 0) {
    logger.warn('アナリティクスデータがありません。x-analytics-daily.jsonl を確認してください。');
    return;
  }

  const { action, reason } = decideAction(records, config);
  logger.info(`判定: ${action.toUpperCase()} | 理由: ${reason}`);

  const latestAvg = records[0]?.avgImpressions ?? 0;
  const historyEntry = {
    date: new Date().toISOString().slice(0, 10),
    level: config.level,
    avgImpPerDay: latestAvg,
    action,
  };

  let newLevel = config.level;
  let newMiss = config.consecutiveMiss;
  let newHit = config.consecutiveHit;

  if (action === 'up') {
    newLevel = Math.min(4, config.level + 1) as 1 | 2 | 3 | 4;
    newMiss = 0;
    newHit = 0;
    logger.info(`🔼 スケールアップ: level ${config.level} → ${newLevel}`);
    logLevelChanges(config.level, newLevel);
  } else if (action === 'down') {
    newLevel = Math.max(1, config.level - 1) as 1 | 2 | 3 | 4;
    newMiss = 0;
    newHit = 0;
    logger.info(`🔽 スケールダウン: level ${config.level} → ${newLevel}`);
  } else {
    if (latestAvg < config.targetImpPerDay) {
      newMiss += 1;
      newHit = 0;
    } else {
      newHit += 1;
      newMiss = 0;
    }
    logger.info(`⏸️  現状維持 (level ${config.level}) | 未達連続: ${newMiss}日 / 達成連続: ${newHit}日`);
  }

  const newConfig: AdaptiveConfig = {
    updatedAt: new Date().toISOString(),
    level: newLevel,
    params: SCALE_LEVELS[newLevel],
    targetImpPerDay: config.targetImpPerDay,
    consecutiveMiss: newMiss,
    consecutiveHit: newHit,
    reason,
    history: [historyEntry, ...config.history].slice(0, 30), // 直近30日分を保持
  };

  if (!dryRun) {
    saveAdaptiveConfig(newConfig);
    logger.info(`設定保存完了: data/adaptive-config.json`);
  } else {
    logger.info('[DRY-RUN] 設定を保存しませんでした');
    logger.info('新しい設定:', JSON.stringify(newConfig.params, null, 2));
  }

  // サマリ出力
  logger.info('=== スケーラー完了 ===');
  logger.info(`  レベル: ${config.level} → ${newLevel}`);
  logger.info(`  引用Bot/回: ${SCALE_LEVELS[newLevel].maxQuotesPerRun}件`);
  logger.info(`  ニュース/slot: ${SCALE_LEVELS[newLevel].batchSizePerSlot}件`);
  logger.info(`  意見Tweet/日: ${SCALE_LEVELS[newLevel].opinionPerDay}件`);
  logger.info(`  note CTA曜日: ${SCALE_LEVELS[newLevel].noteCtaDaysOfWeek.map(dayName).join('・')}`);
}

function logLevelChanges(from: number, to: number): void {
  const prev = SCALE_LEVELS[from as 1 | 2 | 3 | 4];
  const next = SCALE_LEVELS[to as 1 | 2 | 3 | 4];
  if (next.maxQuotesPerRun !== prev.maxQuotesPerRun)
    logger.info(`  引用Bot: ${prev.maxQuotesPerRun} → ${next.maxQuotesPerRun}件/回`);
  if (next.batchSizePerSlot !== prev.batchSizePerSlot)
    logger.info(`  ニュース: ${prev.batchSizePerSlot} → ${next.batchSizePerSlot}件/slot`);
  if (next.opinionPerDay !== prev.opinionPerDay)
    logger.info(`  意見Tweet: ${prev.opinionPerDay} → ${next.opinionPerDay}件/日`);
  const prevDays = prev.noteCtaDaysOfWeek.map(dayName).join('・');
  const nextDays = next.noteCtaDaysOfWeek.map(dayName).join('・');
  if (prevDays !== nextDays)
    logger.info(`  note CTA: ${prevDays} → ${nextDays}`);
}

function dayName(d: number): string {
  return ['日', '月', '火', '水', '木', '金', '土'][d];
}

main().catch((err) => {
  logger.error(`スケーラーエラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
