/**
 * 日次投稿数チェック (#39)
 *
 * 毎日 23:30 JST に前日分の投稿数を集計して KPI 未達 (<15件) を通知する。
 * analytics ログ (x-analytics.jsonl) から全プラットフォームの投稿数を取得する。
 *
 * 使い方:
 *   npx ts-node src/pdca-daily-check.ts
 *   npx ts-node src/pdca-daily-check.ts --dry-run
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { sendKpiAlert } from './utils/alert-notifier';
import { logger } from './utils/logger';

const ANALYTICS_FILE = path.join(process.cwd(), 'data', 'x-analytics.jsonl');
const DAILY_TARGET = 15;

interface AnalyticsRecord {
  postedAt: string;
  slot: string;
  platform?: string;
  success: boolean;
}

function getTargetDate(): string {
  // GitHub Actions は UTC で動作。23:30 JST = UTC 14:30 に実行されるため
  // 「当日 UTC 日付」= JST では翌日になる場合があるので UTC 日付を基準にする
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function countDailyPosts(targetDate: string): {
  total: number;
  byPlatform: Record<string, number>;
  successTotal: number;
} {
  if (!fs.existsSync(ANALYTICS_FILE)) {
    logger.warn(`analytics ファイルが見つかりません: ${ANALYTICS_FILE}`);
    return { total: 0, byPlatform: {}, successTotal: 0 };
  }

  const lines = fs.readFileSync(ANALYTICS_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean);

  const byPlatform: Record<string, number> = {};
  let total = 0;
  let successTotal = 0;

  for (const line of lines) {
    try {
      const rec: AnalyticsRecord = JSON.parse(line);
      // postedAt が targetDate と一致するエントリを集計
      if (!rec.postedAt.startsWith(targetDate)) continue;

      total++;
      if (rec.success) successTotal++;

      const platform = rec.platform ?? 'x';
      byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
    } catch {
      // 不正な JSON 行は無視
    }
  }

  return { total, byPlatform, successTotal };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const targetDate = getTargetDate();
  logger.info(`日次投稿数チェック: ${targetDate} (target: ≥${DAILY_TARGET}件)`);

  const { total, byPlatform, successTotal } = countDailyPosts(targetDate);

  const platformSummary = Object.entries(byPlatform)
    .map(([p, n]) => `  ${p}: ${n}件`)
    .join('\n') || '  (データなし)';

  logger.info(`集計結果:\n${platformSummary}`);
  logger.info(`合計: ${total}件 (成功: ${successTotal}件)`);

  if (total < DAILY_TARGET) {
    const shortfall = DAILY_TARGET - total;
    const title = `📉 日次投稿数未達 [${targetDate}]`;
    const body = [
      `目標: ${DAILY_TARGET}件 / 実績: ${total}件 (${shortfall}件不足)`,
      `成功: ${successTotal}件`,
      '',
      'プラットフォーム別:',
      platformSummary,
      '',
      '対応策:',
      '  - Chatwork メッセージを確認',
      '  - RSS ソースの接続を確認',
      '  - GitHub Actions ログを確認',
    ].join('\n');

    logger.warn(`⚠️ 投稿数未達: ${total}/${DAILY_TARGET}件`);

    if (!dryRun) {
      await sendKpiAlert(title, body).catch(e =>
        logger.warn(`アラート送信失敗: ${e instanceof Error ? e.message : String(e)}`)
      );
      logger.info('✅ アラート送信完了');
    } else {
      logger.info('[DRY-RUN] アラートをスキップ');
      logger.info(`アラート内容:\n${title}\n${body}`);
    }
  } else {
    logger.info(`✅ 投稿数 KPI 達成: ${total}/${DAILY_TARGET}件`);
  }
}

main().catch(err => {
  logger.error(`日次チェックエラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
