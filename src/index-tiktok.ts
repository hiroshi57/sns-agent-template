/**
 * TikTok 自動投稿スケジューラー
 *
 * X.com パイプラインと同じ Chatwork + RSS ソースを使い、
 * TikTok に画像スライド（フォト投稿）として自動転載する。
 *
 * スロット構成（平日のみ・祝日除外）:
 *   12:00 slot11  ランチ: トレンド / ビジネス
 *   19:00 slot17  夜:     開発 / AIエージェント
 *
 * TikTok は動画中心だが、このスクリプトは画像スライド投稿を使う。
 * 画像が取得できないアイテムはスキップする。
 */
import 'dotenv/config';
import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { ChatworkClient } from './chatwork/client';
import { fetchArticle, isSkippableDomain, buildFromMessageBody } from './scraper/article';
import { TikTokPoster } from './tiktok/poster';
import { composeTikTokCaption } from './utils/tiktok-composer';
import { PostedUrlCache } from './utils/posted-url-cache';
import { scoreAndSelectMessages } from './utils/quality-scorer';
import { isJapaneseHoliday } from './utils/holiday';
import { fetchAllRssItems } from './rss/reader';
import { supplementRssItems } from './collectors/web-fallback';
import { buildSlotBatch } from './pipeline/runner';
import { logAnalytics } from './utils/analytics-logger';
import { SlotName, CATEGORY_META } from './utils/x-category';
import { logger } from './utils/logger';
import { sendKpiAlert } from './utils/alert-notifier';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

const BATCH_SIZE = 2;
const POST_RETRY_MAX = 3;

/** TikTok 用スロット → cron マッピング（X.com・Instagram と時間をずらす） */
const TIKTOK_SLOT_CRON: Partial<Record<SlotName, string>> = {
  slot11: '0 12 * * 1-5',  // 12:00 JST 平日
  slot17: '0 19 * * 1-5',  // 19:00 JST 平日
};

const ACTIVE_SLOTS: SlotName[] = ['slot11', 'slot17'];

// ----------------------------------------------------------------
// スロット実行関数
// ----------------------------------------------------------------

async function runSlot(
  slot: SlotName,
  opts: { dryRun?: boolean; force?: boolean } = {}
): Promise<void> {
  const dryRun = opts.dryRun || process.env['DRY_RUN'] === 'true';
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`=== [TikTok/${slot}] 投稿開始 ${dryRun ? '[DRY-RUN]' : ''} ===`);

  const chatworkToken = requireEnv('CHATWORK_API_TOKEN');
  const roomId = requireEnv('CHATWORK_ROOM_ID');
  const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

  const poster = new TikTokPoster({
    username: requireEnv('TIKTOK_USERNAME'),
    password: requireEnv('TIKTOK_PASSWORD'),
    dryRun,
  });

  const postedCache = new PostedUrlCache('data/tiktok-posted-urls.json');
  logger.info(`投稿済みキャッシュ: ${postedCache.size} 件`);

  // ① Chatwork メッセージ取得
  const chatwork = new ChatworkClient(chatworkToken);
  const forceFlag = opts.force ? 1 : 0;
  const allMessages = await chatwork.getMessages(roomId, forceFlag);
  logger.info(`Chatwork 取得: ${allMessages.length} 件`);

  const targetIds = (process.env['CHATWORK_TARGET_ACCOUNT_IDS'] || '')
    .split(',').map(s => s.trim()).filter(Boolean).map(Number);
  const targets = allMessages.filter(m => ChatworkClient.isTransferTarget(m, targetIds));

  // ② キャッシュチェック
  const candidateMessages: Array<{ body: string; urls: string[] }> = [];
  let cacheSkipCount = 0;

  for (const msg of targets) {
    const urls = ChatworkClient.extractUrls(msg.body).filter(u => !postedCache.has(u));
    if (urls.length > 0) candidateMessages.push({ body: msg.body, urls });
    else cacheSkipCount += ChatworkClient.extractUrls(msg.body).length;
  }
  logger.info(`候補: ${candidateMessages.length} 件`);

  // ③ 品質スコアリング
  const qualityTopN = parseInt(process.env['QUALITY_TOP_N'] || '20', 10);
  const selectedMessages = candidateMessages.length > qualityTopN
    ? await scoreAndSelectMessages(anthropic, candidateMessages, qualityTopN)
    : candidateMessages.map(m => ({ ...m, score: 3 }));

  // ④ 記事フルテキスト取得
  const cwArticles = [];
  for (const msg of selectedMessages) {
    for (const url of msg.urls) {
      if (postedCache.has(url)) { cacheSkipCount++; continue; }
      const article = isSkippableDomain(url)
        ? buildFromMessageBody(url, msg.body)
        : await fetchArticle(url).catch(() => null);
      if (article?.isValid) cwArticles.push(article);
    }
  }
  logger.info(`Chatwork 記事: ${cwArticles.length} 件`);

  // ⑤ RSS フィード取得
  let rssItems = await fetchAllRssItems(slot).catch(err => {
    logger.warn(`RSS 取得エラー: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });
  rssItems = await supplementRssItems(rssItems, 10).catch(() => rssItems);

  // ⑥ パイプライン: テーマ別最良記事を選出
  const batch = buildSlotBatch(slot, rssItems, cwArticles, postedCache);
  if (batch.length === 0) {
    logger.info(`[TikTok/${slot}] 投稿候補なし。スキップします。`);
    return;
  }

  // ブラウザ起動
  if (!dryRun) {
    const opened = await poster.open();
    if (!opened) {
      logger.error('TikTok ブラウザ起動に失敗しました。処理を中断します。');
      return;
    }
  }

  let successCount = 0;
  let errorCount = 0;

  try {
    for (const item of batch.slice(0, BATCH_SIZE)) {
      // 画像なしの場合はテキストカード画像を自動生成 (#37)
      if (!item.imageUrl) {
        logger.info(`[TikTok] 画像なし → テキストカード生成: ${item.title.slice(0, 60)}`);
        if (!dryRun) {
          const meta = CATEGORY_META[item.category];
          const cardPath = await poster.generateTextCard({
            title: item.title,
            categoryEmoji: meta.emoji,
            categoryLabel: meta.label,
          }).catch(() => null);
          if (cardPath) {
            item.imageUrl = `file://${cardPath}`;
          } else {
            logger.warn(`[TikTok] テキストカード生成失敗 → スキップ: ${item.title.slice(0, 60)}`);
            continue;
          }
        }
      }

      logger.info(`\n--- [TikTok/${item.category}] ${item.title.slice(0, 60)} ---`);

      const articleForCompose = {
        url: item.url,
        title: item.title,
        summary: item.summary,
        thumbnailUrl: item.imageUrl || '',
        body: item.summary,
        isValid: true,
      };

      const caption = await composeTikTokCaption(anthropic, articleForCompose, {
        category: item.category,
        slot,
      }).catch(err => {
        logger.warn(`キャプション生成失敗 → タイトルで代替: ${err instanceof Error ? err.message : String(err)}`);
        const meta = CATEGORY_META[item.category];
        return `${meta.emoji} ${item.title.slice(0, 50)}\n\n#AI #人工知能 #テクノロジー`;
      });

      // リトライ付き投稿
      let posted = false;
      for (let attempt = 1; attempt <= POST_RETRY_MAX; attempt++) {
        const ok = await poster.post(caption, item.imageUrl);
        if (ok) { posted = true; break; }

        if (attempt < POST_RETRY_MAX) {
          logger.warn(`投稿失敗 (試行 ${attempt}/${POST_RETRY_MAX})。5秒後にリトライ...`);
          await new Promise(r => setTimeout(r, 5000));
          await poster.close();
          const reconnected = await poster.open().catch(() => false);
          if (!reconnected) {
            logger.error('再接続失敗。この記事をスキップします。');
            break;
          }
        }
      }

      logAnalytics({
        postedAt: new Date().toISOString(),
        slot,
        platform: 'tiktok',
        theme: item.category,
        source: rssItems.find(r => r.url === item.url)?.source ?? 'chatwork',
        url: item.url,
        title: item.title,
        imageAttached: !!item.imageUrl && posted,
        success: posted,
        contentLength: caption.length,
      });

      if (posted) {
        successCount++;
        if (!dryRun) postedCache.add(item.url);
        await new Promise(r => setTimeout(r, 5000 + Math.random() * 3000));
      } else {
        errorCount++;
      }
    }
  } finally {
    await poster.close();
  }

  logger.info(
    `=== [TikTok/${slot}] 完了 — 成功: ${successCount} / エラー: ${errorCount}` +
    ` / キャッシュスキップ: ${cacheSkipCount} ===`
  );

  // エラー率 >10% の即時通知 (#38)
  const totalAttempts = successCount + errorCount;
  if (totalAttempts >= 3 && errorCount / totalAttempts > 0.1) {
    const rate = Math.round((errorCount / totalAttempts) * 100);
    await sendKpiAlert(
      `⚠️ TikTok エラー率超過 [${slot}]`,
      `エラー率: ${rate}% (${errorCount}/${totalAttempts}件)\nスロット: ${slot}\n時刻: ${new Date().toISOString()}`
    ).catch(e => logger.warn(`アラート送信失敗: ${e instanceof Error ? e.message : String(e)}`));
  }
}

// ----------------------------------------------------------------
// エントリポイント
// ----------------------------------------------------------------

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isOnce = args.includes('--once');
const isForce = args.includes('--force');

const slotArgIdx = args.indexOf('--slot');
const slotArg = slotArgIdx >= 0 ? args[slotArgIdx + 1] as SlotName : undefined;

if (isDryRun || isOnce || isForce) {
  const targetSlot: SlotName = slotArg ?? 'slot11';
  logger.info(`TikTok 手動実行: ${targetSlot}`);
  runSlot(targetSlot, { dryRun: isDryRun, force: isForce }).catch(err => {
    logger.error(`実行エラー: ${err}`);
    process.exit(1);
  });
} else {
  for (const slot of ACTIVE_SLOTS) {
    const cronExpr = TIKTOK_SLOT_CRON[slot]!;
    logger.info(`TikTok スケジュール登録: ${slot} → ${cronExpr}`);

    cron.schedule(
      cronExpr,
      () => {
        const today = new Date();
        if (isJapaneseHoliday(today)) {
          logger.info(`[TikTok/${slot}] 本日は祝日のためスキップ`);
          return;
        }
        runSlot(slot).catch(err => logger.error(`[TikTok/${slot}] スケジュール実行エラー: ${err}`));
      },
      { timezone: 'Asia/Tokyo' }
    );
  }

  logger.info('TikTok スケジューラー起動中... Ctrl+C で停止');
}
