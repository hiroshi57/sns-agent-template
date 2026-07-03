/**
 * アフィリエイトランキング投稿 CLI エントリーポイント
 *
 * 使い方:
 *   npm run affiliate:post           # X に投稿
 *   npm run affiliate:dry-run        # dry-run（投稿しない）
 *
 * 環境変数は .env から dotenv/config で自動読み込み。
 * 機密情報（APIキー・パスワード）はコード内に書かず、
 * すべて process.env から取得する。
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { XPoster } from './poster';
import { postAffiliateRanking } from './post-affiliate-ranking';
import { logger } from '../utils/logger';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

async function main(): Promise<void> {
  const dryRun = process.env['DRY_RUN'] === 'true' || process.argv.includes('--dry-run');

  logger.info('=== アフィリエイトランキング投稿（X）===');
  logger.info(dryRun ? '[DRY-RUN モード] 実際の投稿はスキップされます' : '[本番モード] X に投稿します');

  const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

  // ── X 投稿 ──────────────────────────────────────────────────
  const xPoster = new XPoster({
    email:    requireEnv('X_EMAIL'),
    password: requireEnv('X_PASSWORD'),
    username: process.env['X_USERNAME'],
    phone:    process.env['X_PHONE'],
    dryRun,
  });

  if (!dryRun) {
    const opened = await xPoster.open();
    if (!opened) {
      logger.error('X ブラウザ起動に失敗しました。npm run x:setup でセッションを更新してください。');
      process.exit(1);
    }
  }

  try {
    await postAffiliateRanking(xPoster, anthropic, { dryRun, topN: 3 });
  } finally {
    if (!dryRun) await xPoster.close();
  }

  logger.info('=== 完了（X）===');
}

main().catch(err => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
