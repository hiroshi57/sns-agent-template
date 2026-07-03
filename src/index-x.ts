/**
 * X 自動投稿スケジューラー
 *
 * 投稿フロー:
 *   ① Chatwork メッセージ取得
 *   ② 意見フィルタ（個人の感情・主観コメントを除外）
 *   ③ 品質スコアリングで上位 N 件を選択
 *   ④ URL ごとに記事フルテキスト取得（fetchArticle）
 *      ＜共有＞タグなど Chatwork 記法を自動除去
 *   ⑤ Claude で要約 → ツイート文生成
 *   ⑥ X.com に投稿（最大 3 回リトライ）
 *   ⑦ 投稿済み URL をキャッシュ（二重投稿防止）
 *   ⑧ RSS フィードで不足分を補充（スロット専用ソース込み）
 *
 * スロット構成（平日のみ・祝日除外）:
 *   07:30 slot07  通勤: トレンド / 海外の流行 / ビジネス / スタートアップ
 *   11:00 slot11  午前: 新モデル / ロードマップ / AIツール / 画像・動画AI
 *   12:00 slot12  昼:   調査手法 / データ統計 / 論文 / RAG・検索
 *   14:00 slot14  午後: カンファレンス / 展示デモ / 規制 / AI倫理
 *   17:00 slot17  夕方: 実装・開発 / 音声マルチモーダル / AIエージェント / OSS
 */
import 'dotenv/config';
import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { ChatworkClient } from './chatwork/client';
import { fetchArticle, isSkippableDomain, buildFromMessageBody } from './scraper/article';
import { XPoster } from './x/poster';
import { postReliefItems } from './x/post-relief';
import { postAffiliateRanking } from './x/post-affiliate-ranking';
import { composeTweet } from './utils/tweet-composer';
import { PostedUrlCache } from './utils/posted-url-cache';
import { scoreAndSelectMessages } from './utils/quality-scorer';
import { fetchAllRssItems } from './rss/reader';
import { supplementRssItems } from './collectors/web-fallback';
import { fetchRedditTrends } from './rss/reddit-researcher';
import { buildSlotBatch } from './pipeline/runner';
import { logAnalytics, logSlotSummary, readAnalyticsRecords } from './utils/analytics-logger';
import { appendNoteWeeklyLog } from './utils/note-weekly-log';
import { SlotName, SLOT_CRON, CATEGORY_META } from './utils/x-category';
import { logger } from './utils/logger';
import { sendKpiAlert } from './utils/alert-notifier';
import { getAdaptiveParams } from './utils/adaptive-config';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

/**
 * 1 スロットあたり投稿件数 — adaptive-config.json の batchSizePerSlot に従う。
 * level 1=2, 2=3, 3=4, 4=5 (最大)。
 * 投稿数目安: 平日 5slot × N件, 週末 3slot × N件 (slot07/11/12)
 */
const BATCH_SIZE = getAdaptiveParams().batchSizePerSlot;
/** リトライ上限 */
const POST_RETRY_MAX = 3;

// ----------------------------------------------------------------
// スロット実行関数
// ----------------------------------------------------------------

/** スロット全体のタイムアウト: 10分 */
const SLOT_TIMEOUT_MS = 10 * 60 * 1000;

export async function runSlot(
  slot: SlotName,
  opts: { dryRun?: boolean; force?: boolean; xPoster?: XPoster } = {}
): Promise<void> {
  const dryRun = opts.dryRun || process.env['DRY_RUN'] === 'true';
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`=== [${slot}] 投稿開始 ${dryRun ? '[DRY-RUN]' : ''} ===`);

  const chatworkToken = requireEnv('CHATWORK_API_TOKEN');
  const roomId = requireEnv('CHATWORK_ROOM_ID');
  const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

  const xPoster = opts.xPoster ?? new XPoster({
    email: requireEnv('X_EMAIL'),
    password: requireEnv('X_PASSWORD'),
    username: process.env['X_USERNAME'],
    phone: process.env['X_PHONE'],
    dryRun,
  });
  const ownsXPoster = !opts.xPoster;

  // X 専用の投稿済みキャッシュ
  const postedCache = new PostedUrlCache('data/x-posted-urls.json');
  logger.info(`投稿済みキャッシュ: ${postedCache.size} 件`);

  // ----------------------------------------------------------------
  // ① Chatwork メッセージ取得
  // ----------------------------------------------------------------
  const chatwork = new ChatworkClient(chatworkToken);
  const forceFlag = opts.force ? 1 : 0;
  const allMessages = await chatwork.getMessages(roomId, forceFlag);
  logger.info(`Chatwork 取得: ${allMessages.length} 件`);

  const targetIds = (process.env['CHATWORK_TARGET_ACCOUNT_IDS'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const targets = allMessages.filter((m) => ChatworkClient.isTransferTarget(m, targetIds));
  logger.info(`転送対象: ${targets.length} 件`);

  // ----------------------------------------------------------------
  // ② キャッシュチェック（意見フィルタなし: Chatwork の全メッセージを対象）
  // ----------------------------------------------------------------
  const candidateMessages: Array<{ body: string; urls: string[] }> = [];
  let cacheSkipCount = 0;

  for (const msg of targets) {
    const urls = ChatworkClient.extractUrls(msg.body).filter((u) => !postedCache.has(u));
    if (urls.length > 0) {
      candidateMessages.push({ body: msg.body, urls });
    } else {
      cacheSkipCount += ChatworkClient.extractUrls(msg.body).length;
    }
  }
  logger.info(
    `候補: ${candidateMessages.length} 件 (キャッシュ済みスキップ: ${cacheSkipCount})`
  );

  // ----------------------------------------------------------------
  // ③ 品質スコアリングで上位 N 件を選択
  // ----------------------------------------------------------------
  const qualityTopN = parseInt(process.env['QUALITY_TOP_N'] || '20', 10);
  const selectedMessages = candidateMessages.length > qualityTopN
    ? await scoreAndSelectMessages(anthropic, candidateMessages, qualityTopN)
    : candidateMessages.map(m => ({ ...m, score: 3 }));

  // ----------------------------------------------------------------
  // ④ 記事フルテキスト取得（＜共有＞など Chatwork 記法は buildFromMessageBody 内で自動除去済み）
  // ----------------------------------------------------------------
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
  logger.info(`Chatwork 記事: ${cwArticles.length} 件（フルテキスト取得済み）`);

  // ----------------------------------------------------------------
  // ⑧ RSS フィード取得（Chatwork の補充・スロット専用ソース込み）
  // ----------------------------------------------------------------
  logger.info(`RSS フィード取得中... (スロット: ${slot})`);
  let rssItems = await fetchAllRssItems(slot).catch((err) => {
    logger.warn(`RSS 取得エラー: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });

  rssItems = await supplementRssItems(rssItems, 15).catch((err) => {
    logger.warn(`補助収集エラー: ${err instanceof Error ? err.message : String(err)}`);
    return rssItems;
  });

  // ── ⑨ Reddit トレンドリサーチ（バイラル指標上位を補充）──
  // スロット別 subreddit から今日の Hot/Top をエンゲージメント順で取得し、
  // RSS アイテムの末尾に追加する（既存ソースが優先・不足時の補充に使用）
  const redditItems = await fetchRedditTrends(slot, 3).catch((err) => {
    logger.warn(`[Reddit] 取得失敗（スキップ）: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });
  if (redditItems.length > 0) {
    logger.info(`[Reddit] ${redditItems.length} 件をパイプラインに追加`);
    rssItems = [...rssItems, ...redditItems];
  }

  // ----------------------------------------------------------------
  // パイプライン: テーマ別最良記事を選出
  // ----------------------------------------------------------------
  // クロススロット重複防止: 直近24h に投稿したタイトルを収集し、
  // 同じトピックが異なるスロットで重複投稿されるのを防ぐ
  const recentRecords = readAnalyticsRecords(1);
  const recentPostedTitles = recentRecords
    .filter(r => r.success && r.title)
    .map(r => r.title);
  if (recentPostedTitles.length > 0) {
    logger.info(`[重複防止] 直近24h 投稿タイトル: ${recentPostedTitles.length} 件をクロススロットチェックに使用`);
  }

  const batch = buildSlotBatch(slot, rssItems, cwArticles, postedCache, BATCH_SIZE, undefined, recentPostedTitles);
  if (batch.length === 0) {
    logger.info(`[${slot}] 投稿候補なし。スキップします。`);
    return;
  }

  // ----------------------------------------------------------------
  // ブラウザ起動（外部注入時はすでに open 済みのためスキップ）
  // ----------------------------------------------------------------
  if (!dryRun && ownsXPoster) {
    const opened = await xPoster.open();
    if (!opened) {
      logger.error('X.com ブラウザ起動に失敗しました。処理を中断します。');
      return;
    }
  }

  let successCount = 0;
  let errorCount = 0;

  try {
    for (const item of batch.slice(0, BATCH_SIZE)) {
      logger.info(`\n--- [${item.category}] ${item.title.slice(0, 60)} ---`);

      // ツイート文生成（Forte の generateSummaryBody に相当）
      const articleForCompose = {
        url: item.url,
        title: item.title,
        summary: item.summary,
        thumbnailUrl: item.imageUrl || '',
        body: item.summary,
        isValid: true,
      };

      const tweetText = await composeTweet(anthropic, articleForCompose, {
        category: item.category,
        hashtags: item.hashtags,
        slot,
      }).catch((err) => {
        if (err instanceof Error && err.message === 'TWEET_TOO_SHORT') {
          return null; // 短文フィルタによる除外マーカー
        }
        logger.warn(`ツイート文生成失敗 → タイトルで代替: ${err instanceof Error ? err.message : String(err)}`);
        const meta = CATEGORY_META[item.category];
        return `${meta.emoji}【${meta.label}】\n${item.title}\n${item.url}\n\n${item.hashtags}`;
      });

      if (tweetText === null) {
        logger.warn(`短文ツイートをスキップ: "${item.title.slice(0, 60)}"`);
        continue;
      }

      // ⑥ リトライ付き投稿（最大 POST_RETRY_MAX 回）
      let posted = false;
      for (let attempt = 1; attempt <= POST_RETRY_MAX; attempt++) {
        const ok = await xPoster.tweet(tweetText, item.imageUrl);
        if (ok) { posted = true; break; }

        if (attempt < POST_RETRY_MAX) {
          logger.warn(`投稿失敗 (試行 ${attempt}/${POST_RETRY_MAX})。5秒後にリトライします...`);
          await new Promise((r) => setTimeout(r, 5000));
          // 再接続してリトライ
          await xPoster.close();
          const reconnected = await xPoster.open().catch(() => false);
          if (!reconnected) {
            logger.error('再接続失敗。この記事をスキップします。');
            break;
          }
        } else {
          logger.error(`${POST_RETRY_MAX} 回試行しましたが投稿できませんでした: ${item.title}`);
        }
      }

      // ⑦ 投稿済みキャッシュに追加
      logAnalytics({
        postedAt: new Date().toISOString(),
        slot,
        platform: 'x',
        theme: item.category,
        source: rssItems.find((r) => r.url === item.url)?.source ?? 'chatwork',
        url: item.url,
        title: item.title,
        imageAttached: !!item.imageUrl && posted,
        success: posted,
        contentLength: tweetText.length,
      });

      if (posted) {
        successCount++;
        if (!dryRun) {
          postedCache.add(item.url);
          // note 週次まとめ記事用にログを追記
          appendNoteWeeklyLog({
            postedAt: new Date().toISOString(),
            url: item.url,
            title: item.title,
            summary: item.summary,
            category: item.category,
            imageUrl: item.imageUrl,
          });
        }
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));
      } else {
        errorCount++;
      }
    }
  } finally {
    // 外部注入の場合は呼び出し元がブラウザを管理する
    if (ownsXPoster) await xPoster.close();
  }

  logger.info(
    `=== [${slot}] 完了 — 成功: ${successCount} / エラー: ${errorCount}` +
    ` / キャッシュスキップ: ${cacheSkipCount} ===`
  );

  // ── スロット実績を x-slot-summary.jsonl に記録 ──
  const categoriesUsed = [...new Set(batch.map((b) => b.category))];
  logSlotSummary({
    type: 'slot_summary',
    date: new Date().toISOString().slice(0, 10),
    executedAt: new Date().toISOString(),
    slot,
    totalMessages: targets.length,
    opinionSkipped: 0,
    cacheSkipped: cacheSkipCount,
    qualityCandidates: cwArticles.length + rssItems.length,
    batchSize: batch.length,
    succeeded: successCount,
    errored: errorCount,
    categoriesUsed,
    dryRun,
  });

  // エラー率 >10% の即時通知 (#38)
  const totalAttempts = successCount + errorCount;
  if (totalAttempts >= 3 && errorCount / totalAttempts > 0.1) {
    const rate = Math.round((errorCount / totalAttempts) * 100);
    await sendKpiAlert(
      `⚠️ X エラー率超過 [${slot}]`,
      `エラー率: ${rate}% (${errorCount}/${totalAttempts}件)\nスロット: ${slot}\n時刻: ${new Date().toISOString()}`
    ).catch(e => logger.warn(`アラート送信失敗: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/**
 * 単発実行（CI: x-daily-transfer.yml の `x:once` が使用）
 *
 * runSlot（AIニュース 4-5件）に加えて、post-all-slots.ts と同じ追加配信を行う:
 *   - ネタ系（relief）1件 … 全スロット
 *   - アフィリエイトランキング TOP3 … slot11 のみ（同日重複は内部キャッシュで防止）
 * ブラウザセッションは全投稿で共有する（ログイン回数を最小化）。
 */
export async function runOnceWithExtras(
  slot: SlotName,
  opts: { dryRun?: boolean; force?: boolean } = {}
): Promise<void> {
  const dryRun = opts.dryRun || process.env['DRY_RUN'] === 'true';
  const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  const xPoster = new XPoster({
    email: requireEnv('X_EMAIL'),
    password: requireEnv('X_PASSWORD'),
    username: process.env['X_USERNAME'],
    phone: process.env['X_PHONE'],
    dryRun,
  });

  const opened = await xPoster.open();
  if (!opened) {
    throw new Error('X.com ブラウザ起動に失敗しました（セッション失効の可能性）');
  }

  try {
    await runSlot(slot, { ...opts, dryRun, xPoster });

    // ── ネタ系（relief）1件 ──
    await postReliefItems(xPoster, anthropic, 1, { dryRun }).catch((err) => {
      logger.warn(`[${slot}] ネタ系投稿エラー（スキップ）: ${err instanceof Error ? err.message : String(err)}`);
    });

    // ── アフィリエイトランキング（slot11 のみ・1日1回）──
    if (slot === 'slot11') {
      await postAffiliateRanking(xPoster, anthropic, { dryRun, topN: 3 }).catch((err) => {
        logger.warn(`[${slot}] アフィリエイト投稿エラー（スキップ）: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  } finally {
    await xPoster.close();
  }
}

// ----------------------------------------------------------------
// エントリポイント（直接実行時のみ — import 時は実行しない）
// ----------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isOnce = args.includes('--once');
  const isForce = args.includes('--force');
  const isReport = args.includes('--report');

  const slotArgIdx = args.indexOf('--slot');
  const slotArg = slotArgIdx >= 0 ? args[slotArgIdx + 1] as SlotName : undefined;

  if (isReport) {
    const { printWeeklySummary } = require('./utils/analytics-logger');
    printWeeklySummary();
  } else if (isDryRun || isOnce || isForce) {
    const targetSlot: SlotName = slotArg ?? 'slot07';
    logger.info(`手動実行: ${targetSlot}（ネタ系1件 + slot11時アフィリエイト込み）`);
    runOnceWithExtras(targetSlot, { dryRun: isDryRun, force: isForce }).catch((err) => {
      logger.error(`実行エラー: ${err}`);
      process.exit(1);
    });
  } else {
    const ALL_SLOTS: SlotName[] = ['slot07', 'slot11', 'slot12', 'slot14', 'slot17'];

    for (const slot of ALL_SLOTS) {
      const cronExpr = SLOT_CRON[slot];
      logger.info(`スケジュール登録: ${slot} → ${cronExpr} (土日・祝日含む毎日)`);

      cron.schedule(
        cronExpr,
        () => {
          // 祝日・週末も投稿継続（スキップしない）
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`[${slot}] タイムアウト (${SLOT_TIMEOUT_MS / 60000}分)`)), SLOT_TIMEOUT_MS)
          );
          Promise.race([runSlot(slot), timeout])
            .catch((err) => logger.error(`[${slot}] スケジュール実行エラー: ${err}`));
        },
        { timezone: 'Asia/Tokyo' }
      );
    }

    logger.info('スケジューラー起動中... Ctrl+C で停止');
    logger.info('手動実行: npm run x:once [-- --slot slot11]');
  }
}
