/**
 * X 自動エンゲージメント CLI エントリポイント
 *
 * 使い方:
 *   npm run x:engage           # 1件引用（通常実行）
 *   npm run x:engage:dry       # ドライラン（実投稿なし）
 *
 * 環境変数:
 *   MAX_QUOTES=2               # 1回の実行で引用する最大件数（デフォルト 1）
 *   MIN_LIKES=500              # いいね数の下限（デフォルト 100）
 *
 * pm2 cron:
 *   09:00 JST = UTC 00:00 → x-auto-engage-morning
 *   15:00 JST = UTC 06:00 → x-auto-engage-noon
 *   21:00 JST = UTC 12:00 → x-auto-engage-evening
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { XPoster } from './poster';
import { runAutoEngage } from './auto-engage';
import { getAdaptiveParams } from '../utils/adaptive-config';
import { logger } from '../utils/logger';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const minLikes = parseInt(process.env['MIN_LIKES'] ?? '100', 10);

  // アダプティブ設定を優先（env で上書き可）
  const adaptiveParams = getAdaptiveParams();
  const maxQuotes = process.env['MAX_QUOTES']
    ? parseInt(process.env['MAX_QUOTES'], 10)
    : adaptiveParams.maxQuotesPerRun;

  logger.info('=== X 自動エンゲージメント開始 ===');
  logger.info(`  dryRun=${dryRun}  maxQuotes=${maxQuotes}(adaptive)  minLikes=${minLikes}`);

  const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

  const poster = new XPoster({
    email: requireEnv('X_EMAIL'),
    password: requireEnv('X_PASSWORD'),
    username: process.env['X_USERNAME'],
    phone: process.env['X_PHONE'],
    dryRun,
  });

  if (!dryRun) {
    logger.info('ブラウザを起動してログイン中...');
    const opened = await poster.open();
    if (!opened) {
      logger.error('X.com へのログインに失敗しました');
      process.exit(1);
    }
    logger.info('ログイン成功');
  }

  try {
    const result = await runAutoEngage(poster, anthropic, {
      dryRun,
      maxQuotes,
      minLikes,
    });

    logger.info('=== 自動エンゲージメント完了 ===');
    logger.info(`  引用: ${result.quoted}件 / スキップ: ${result.skipped}件 / 候補: ${result.candidates}件`);

    if (result.quoted === 0 && result.candidates === 0) {
      logger.warn('候補ゼロ: 引用済みキャッシュ満杯 or likes 閾値を下げてみてください（MIN_LIKES=50）');
    }
  } finally {
    if (!dryRun) {
      await poster.close();
    }
  }
}

main().catch((err) => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
