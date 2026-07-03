/**
 * SEO アフィリエイト記事 × Note URL を X に投稿するワンショットスクリプト
 *
 * 使い方:
 *   npm run seo:post-x           # 3本すべて投稿
 *   npm run seo:post-x:dry       # dry-run
 */
import 'dotenv/config';
import { XPoster } from './poster';
import { logAnalytics } from '../utils/analytics-logger';
import { logger } from '../utils/logger';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

const SEO_POSTS = [
  {
    key: 'headphone',
    slot: 'slot07' as const,
    theme: 'trend' as const,
    text: `🎧【WH-1000XM5の悪い点、正直に書きました】

よく聞かれるので本音で答えます。

❌ 折りたたみ不可でかさばる
❌ 4万円は高い
❌ 有線時の音質が落ちる

でも——

✅ NC性能は現行最高水準
✅ 30時間バッテリー
✅ テレワーカーの集中力が変わる

「買うべき人・やめるべき人」まとめました👇

https://note.com/modern_yarrow516/n/ncc992a0daba2

#ヘッドフォン #Sony #テレワーク #ガジェット`,
  },
  {
    key: 'pc',
    slot: 'slot11' as const,
    theme: 'trend' as const,
    text: `💻【MacBook Air M4、ギフトで贈るなら何GB選ぶべきか】

結論から言うと——

256GB → 自分用・クラウド中心ならOK
512GB → ギフトなら絶対こっち

理由：後から「容量が足りない」と困るのはもらった側。
プレゼントは余裕のあるスペックを選ぶのが正解。

M4になって何が変わったか、選び方の全部👇

https://note.com/modern_yarrow516/n/nebb55a4b6ad5

#MacBook #Apple #ギフト #プレゼント #ガジェット`,
  },
  {
    key: 'monitor',
    slot: 'slot14' as const,
    theme: 'trend' as const,
    text: `🖥️【モニター選びで後悔する人に共通する3つのミス】

① グレア（光沢）パネルを選んで目が疲れる
② 4Kだけ見てリフレッシュレートを確認しない
③ 高さ調整なしで首と肩が痛くなる

テレワーク用に最初の1台買うなら
「27インチ QHD IPS ノングレア」が最適解。

後悔しない選び方、全部まとめました👇

https://note.com/modern_yarrow516/n/ne3d1d34e5d23

#モニター #テレワーク #在宅勤務 #PC #仕事効率化`,
  },
];

async function main(): Promise<void> {
  const dryRun = process.env['DRY_RUN'] === 'true' || process.argv.includes('--dry-run');

  logger.info('=== SEO アフィリエイト記事 X 投稿 ===');
  if (dryRun) logger.info('[DRY-RUN] 実際の投稿はスキップ');

  const xPoster = new XPoster({
    email: requireEnv('X_EMAIL'),
    password: requireEnv('X_PASSWORD'),
    username: process.env['X_USERNAME'],
    phone: process.env['X_PHONE'],
    dryRun,
  });

  if (!dryRun) {
    const opened = await xPoster.open();
    if (!opened) {
      logger.error('X ブラウザ起動失敗。npm run x:setup でセッションを更新してください。');
      process.exit(1);
    }
  }

  let successCount = 0;
  try {
    for (const post of SEO_POSTS) {
      logger.info(`\n[${post.key}] 投稿中...`);
      if (dryRun) {
        logger.info(`[DRY-RUN] ${post.text.slice(0, 80)}...`);
        successCount++;
        continue;
      }

      const ok = await xPoster.tweet(post.text);
      logAnalytics({
        postedAt: new Date().toISOString(),
        slot: post.slot,
        platform: 'x',
        theme: post.theme,
        source: `seo-content:${post.key}`,
        url: '',
        title: post.text.split('\n')[0],
        imageAttached: false,
        success: ok,
        contentLength: post.text.length,
      });

      if (ok) {
        successCount++;
        logger.info(`✅ [${post.key}] 投稿成功`);
      } else {
        logger.error(`❌ [${post.key}] 投稿失敗`);
      }

      // 投稿間に15秒待機（レートリミット回避）
      if (SEO_POSTS.indexOf(post) < SEO_POSTS.length - 1 && !dryRun) {
        logger.info('次の投稿まで15秒待機...');
        await new Promise(r => setTimeout(r, 15000));
      }
    }
  } finally {
    if (!dryRun) await xPoster.close();
  }

  logger.info(`\n=== 完了: ${successCount}/${SEO_POSTS.length} 本投稿 ===`);
}

main().catch(err => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
