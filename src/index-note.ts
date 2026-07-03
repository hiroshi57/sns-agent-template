/**
 * note 日次まとめ記事 自動投稿スケジューラー
 *
 * 毎日 07:30 JST に実行:
 * 1. data/note-weekly-log.json から当日（1日分）の X.com 投稿済みアイテムを取得
 * 2. Claude で日次まとめ記事を生成
 * 3. note に投稿（自社サービス誘導フッター付き）
 * 4. 30日超の古いログエントリを削除
 */
import 'dotenv/config';
import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { NotePublisher } from './note/publisher';
import { composeNoteArticle } from './utils/note-composer';
import { getRecentItems, pruneOldEntries, NoteWeeklyItem } from './utils/note-weekly-log';
import { logger } from './utils/logger';
import { logAnalytics } from './utils/analytics-logger';
import { isJapaneseHoliday } from './utils/holiday';
import { fetchAllRssItems } from './rss/reader';
import { CATEGORY_META } from './utils/x-category';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

const POST_RETRY_MAX = 3;

// ----------------------------------------------------------------
// 日次実行関数
// ----------------------------------------------------------------

async function runDaily(opts: { dryRun?: boolean } = {}): Promise<void> {
  const dryRun = opts.dryRun || process.env['DRY_RUN'] === 'true';
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`=== [note 日次] 記事投稿開始 ${dryRun ? '[DRY-RUN]' : ''} ===`);

  const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

  // 当日1日分のアイテムを取得
  let items = getRecentItems(1);
  logger.info(`日次ログ取得: ${items.length} 件`);

  if (items.length === 0) {
    logger.warn('[note 日次] note-weekly-log.json が0件 → RSS フォールバックで代替記事を生成します');
    try {
      const rssItems = await fetchAllRssItems();
      const fallbackItems: NoteWeeklyItem[] = rssItems
        .filter((item) => item.publishedAt > new Date(Date.now() - 48 * 60 * 60 * 1000))
        .slice(0, 8)
        .map((item) => ({
          postedAt: item.publishedAt.toISOString(),
          url: item.url,
          title: item.title,
          summary: item.summary,
          category: 'trend' as const, // デフォルトカテゴリ
          imageUrl: item.imageUrl,
        }));

      if (fallbackItems.length === 0) {
        logger.warn('[note 日次] RSS フォールバックも0件。スキップします。');
        return;
      }
      logger.info(`[note 日次] RSS フォールバック: ${fallbackItems.length} 件で記事を生成`);
      items = fallbackItems;
    } catch (fallbackErr) {
      logger.warn(
        `[note 日次] RSS フォールバック取得失敗: ` +
        `${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`
      );
      logger.info('[note 日次] スキップします。');
      return;
    }
  }

  // 記事生成
  logger.info('note 記事を生成中...');
  let article;
  try {
    article = await composeNoteArticle(anthropic, items);
    logger.info(`タイトル: ${article.title}`);
    logger.info(`本文: ${article.body.length}文字`);

    if (dryRun) {
      logger.info(`[DRY-RUN] note 記事プレビュー:\n${article.title}\n\n${article.body.slice(0, 500)}...`);
    }
  } catch (err) {
    logger.error(`note 記事生成失敗: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (dryRun) {
    logger.info('[DRY-RUN] note 投稿はスキップしました。');
    return;
  }

  // note に投稿
  const publisher = new NotePublisher({
    email: requireEnv('NOTE_EMAIL'),
    password: requireEnv('NOTE_PASSWORD'),
    dryRun,
  });

  const opened = await publisher.open();
  if (!opened) {
    logger.error('note ブラウザ起動に失敗しました。処理を中断します。');
    return;
  }

  let posted = false;
  try {
    for (let attempt = 1; attempt <= POST_RETRY_MAX; attempt++) {
      const publishedUrl = await publisher.publish(article.title, article.body);
      if (publishedUrl) { posted = true; break; }

      if (attempt < POST_RETRY_MAX) {
        logger.warn(`note 投稿失敗 (試行 ${attempt}/${POST_RETRY_MAX})。5秒後にリトライ...`);
        await new Promise(r => setTimeout(r, 5000));
        await publisher.close();
        const reconnected = await publisher.open().catch(() => false);
        if (!reconnected) {
          logger.error('note 再接続失敗。処理を中断します。');
          break;
        }
      } else {
        logger.error(`note: ${POST_RETRY_MAX} 回試行しましたが投稿できませんでした`);
      }
    }
  } finally {
    await publisher.close();
  }

  // analytics に記録
  logAnalytics({
    postedAt: new Date().toISOString(),
    slot: 'note_daily',
    platform: 'note',
    theme: 'trend',
    source: 'daily_batch',
    url: 'https://note.com',
    title: article.title,
    imageAttached: false,
    success: posted,
    contentLength: article.body.length,
  });

  if (posted) {
    logger.info('=== [note 日次] 記事投稿完了 ===');
    // 古いエントリを削除（30日超）
    pruneOldEntries();
  } else {
    logger.error('=== [note 日次] 記事投稿失敗 ===');
  }
}

// ----------------------------------------------------------------
// エントリポイント
// ----------------------------------------------------------------

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isOnce = args.includes('--once');

if (isDryRun || isOnce) {
  logger.info('note 手動実行');
  runDaily({ dryRun: isDryRun }).catch(err => {
    logger.error(`実行エラー: ${err}`);
    process.exit(1);
  });
} else {
  // 平日（月〜金）07:30 JST（祝日はスキップ）
  cron.schedule(
    '30 7 * * 1-5',
    () => {
      const today = new Date();
      if (isJapaneseHoliday(today)) {
        logger.info('[note 日次] 本日は祝日のためスキップします');
        return;
      }
      runDaily().catch(err => logger.error(`[note 日次] スケジュール実行エラー: ${err}`));
    },
    { timezone: 'Asia/Tokyo' }
  );

  logger.info('note 日次スケジューラー起動中... 平日 07:30 JST に実行（祝日除く）');
  logger.info('手動実行: npm run note:daily または npm run note:dry-run');
}
