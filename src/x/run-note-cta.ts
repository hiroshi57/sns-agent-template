/**
 * note 誘導ツイート CLI（施策E）
 *
 * 使い方:
 *   npm run x:note-cta          # 通常実行
 *   npm run x:note-cta:dry      # ドライラン
 *
 * pm2 cron:
 *   水曜 18:00 JST = UTC 09:00 → x-note-cta-wed
 *   金曜 18:00 JST = UTC 09:00 → x-note-cta-fri
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { XPoster } from './poster';
import { postNoteCtaTweet } from './post-note-cta';
import { shouldPostNoteCta, loadAdaptiveConfig } from '../utils/adaptive-config';
import { logger } from '../utils/logger';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const forceRun = process.argv.includes('--force') || process.env['FORCE_NOTE_CTA'] === 'true';

  // アダプティブ設定で「今日は投稿日か」を判断（--force で強制実行可）
  if (!forceRun && !shouldPostNoteCta()) {
    const config = loadAdaptiveConfig();
    const { noteCtaDaysOfWeek } = config.params;
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    logger.info(
      `[note-cta] 本日はスキップ（level ${config.level} の投稿日: ` +
      `${noteCtaDaysOfWeek.map((d) => dayNames[d]).join('・')}）`,
    );
    process.exit(0);
  }

  logger.info(`=== note 誘導ツイート開始 (dryRun=${dryRun}) ===`);

  const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  const poster = new XPoster({
    email: requireEnv('X_EMAIL'),
    password: requireEnv('X_PASSWORD'),
    username: process.env['X_USERNAME'],
    phone: process.env['X_PHONE'],
    dryRun,
  });

  if (!dryRun) {
    const opened = await poster.open();
    if (!opened) {
      logger.error('X.com へのログインに失敗しました');
      process.exit(1);
    }
  }

  try {
    const result = await postNoteCtaTweet(poster, anthropic, { dryRun });
    if (result.success) {
      logger.info('=== note 誘導ツイート完了 ===');
      logger.info(`  URL: ${result.noteUrl}`);
    } else {
      logger.warn('=== note 誘導ツイート: スキップ（URL 未設定） ===');
      process.exit(0);
    }
  } finally {
    if (!dryRun) await poster.close();
  }
}

main().catch((err) => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
