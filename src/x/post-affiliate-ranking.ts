/**
 * アフィリエイト製品ランキング投稿モジュール
 *
 * 機能:
 *   ① data/affiliate-products.json から製品データを読み込む
 *   ② スコアリングで上位3製品を選出（売上ランク × 評価 × トレンド度）
 *   ③ Claude Haiku でランキング紹介ツイート文を生成
 *   ④ X に投稿（通常投稿とは別で追加投稿）
 *
 * 投稿フォーマット例:
 *   🏆【AIガジェット 今週の人気ランキング TOP3】
 *
 *   🥇1位: MacBook Air M4
 *   → M4チップで生成AI処理が爆速。Copilot対応で仕事が劇的に変わる
 *   👉 https://amzn.to/xxxxx
 *
 *   🥈2位: Echo Show 10
 *   → ChatGPT連携で家中がAIスマートホームに
 *   👉 https://amzn.to/yyyyy
 *
 *   🥉3位: Sony WH-1000XM5
 *   → AI搭載NCで集中力MAX。テレワーカー必携
 *   👉 https://amzn.to/zzzzz
 *
 *   #AIガジェット #おすすめ商品 #Amazon #ランキング
 *
 * ※ 通常の AI ニュース投稿（runSlot）の後に追加で呼び出す。
 *   通常投稿は一切変更しない。
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { XPoster } from './poster';
import { PostedUrlCache } from '../utils/posted-url-cache';
import { logAnalytics } from '../utils/analytics-logger';
import { selectCategory } from '../utils/category';
import {
  loadAffiliateProducts,
  rankProducts,
  RankedProduct,
  getRankEmoji,
  formatPrice,
} from '../utils/affiliate-products';
import { logger } from '../utils/logger';

const AFFILIATE_POST_LOG = path.join(process.cwd(), 'data', 'affiliate-post-log.jsonl');

/** アフィリエイト投稿をログファイルに記録する */
function logAffiliatePost(entry: {
  postedAt: string;
  platform: string;
  products: { rank: number; id: string; name: string; price?: number; affiliateUrl: string }[];
  rankingTitle: string;
  success: boolean;
  dryRun: boolean;
}): void {
  try {
    fs.mkdirSync(path.dirname(AFFILIATE_POST_LOG), { recursive: true });
    fs.appendFileSync(AFFILIATE_POST_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* ignore */ }
}

// ----------------------------------------------------------------
// ツイート文生成
// ----------------------------------------------------------------

/**
 * Claude Haiku でランキング紹介ツイートを生成する
 *
 * 上限: 280 weighted characters
 * ※ アフィリエイトURLが複数あるため、URLはツイート内に直接埋め込む
 *   （post-all-slots と異なり URL を末尾に1つ付けるのではなく本文内に含む）
 */
async function composeRankingTweet(
  anthropic: Anthropic,
  products: RankedProduct[],
  rankingPeriod: string,
  rankingTitle: string,
): Promise<string> {
  // 製品情報をプロンプト用にフォーマット
  const productList = products.map(p => {
    const priceStr = p.price ? `（${formatPrice(p.price)}前後）` : '';
    return `${getRankEmoji(p.rank)}${p.rank}位: ${p.name}${priceStr}
   アピールポイント: ${p.highlight}
   アフィリエイトURL: ${p.affiliateUrl}`;
  }).join('\n\n');

  const hashtags = buildHashtags(products);

  const prompt = `あなたはSNSマーケターです。
以下のAI・テクノロジー製品ランキング情報を元に、
X（旧Twitter）投稿文を日本語で作成してください。

【ランキングタイトル】
🏆【${rankingTitle}】

【${rankingPeriod}の人気製品 TOP${products.length}】
${productList}

【作成ルール】
1. 冒頭は「🏆【${rankingTitle}】」から始める
2. 各製品を以下の形式で紹介（順位ごとに改行）:
   ${getRankEmoji(1)}1位: [製品名]
   → [アピール文：25文字以内で「なぜ今売れているか・何がすごいか」を凝縮]
   👉 [アフィリエイトURL]

   ※ 2位・3位も同じ形式
3. 末尾に改行して以下のハッシュタグを追加（変えないこと）:
   ${hashtags}
4. 全体で280文字（X換算）以内に収める
5. 「今週」「人気」「売れ筋」などの言葉でホット感を出す
6. アフィリエイトURLは省略・変更しないこと（👉 の後にそのまま貼る）
7. 本文のみ出力（説明・前置き不要）

重要: URLは必ずそのまま含めること。`;

  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content.find(b => b.type === 'text')?.text?.trim() ?? '';
    if (text && !text.includes('申し訳') && !text.includes('できません') && text.length > 50) {
      logger.info(`[Affiliate] ツイート文生成成功: ${text.length}文字`);
      return text;
    }
    logger.warn('[Affiliate] Claude の生成結果が不正 → テンプレートで代替');
  } catch (err) {
    logger.warn(`[Affiliate] ツイート文生成失敗: ${err instanceof Error ? err.message : String(err)}`);
  }

  // フォールバック: テンプレートベースで生成
  return buildFallbackTweet(products, rankingTitle, rankingPeriod, hashtags);
}

/**
 * フォールバック用テンプレートツイート
 * Claude 呼び出し失敗時に使用
 */
function buildFallbackTweet(
  products: RankedProduct[],
  rankingTitle: string,
  rankingPeriod: string,
  hashtags: string,
): string {
  const lines: string[] = [`🏆【${rankingTitle}】`, `${rankingPeriod}の売れ筋 TOP${products.length}`, ''];

  for (const p of products) {
    lines.push(`${getRankEmoji(p.rank)}${p.rank}位: ${p.name}`);
    lines.push(`→ ${p.highlight}`);
    lines.push(`👉 ${p.affiliateUrl}`);
    lines.push('');
  }

  lines.push(hashtags);

  return lines.join('\n').trim();
}

/**
 * 製品のタグから投稿用ハッシュタグを生成する
 */
function buildHashtags(products: RankedProduct[]): string {
  const tagSet = new Set<string>();

  // 製品タグを収集（最大3製品 × 各3タグ）
  for (const p of products) {
    for (const tag of p.tags.slice(0, 3)) {
      tagSet.add(`#${tag.replace(/^#/, '')}`);
    }
  }

  // 固定ハッシュタグ
  const fixed = ['#ランキング', '#おすすめ', '#Amazon'];
  const productTags = [...tagSet].slice(0, 3);

  return [...productTags, ...fixed].join(' ');
}

// ----------------------------------------------------------------
// 二重投稿防止キャッシュ（製品ID + 日付でキー生成）
// ----------------------------------------------------------------

/** アフィリエイトランキング専用の投稿済みキャッシュファイル */
const AFFILIATE_CACHE_FILE = 'data/x-affiliate-posted.json';

/**
 * 今日すでに同じ製品セットを投稿済みかどうかチェック
 * キー: "YYYY-MM-DD:productId1,productId2,productId3"
 */
function buildCacheKey(products: RankedProduct[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const ids = products.map(p => p.id).join(',');
  return `affiliate:${today}:${ids}`;
}

// ----------------------------------------------------------------
// 公開 API
// ----------------------------------------------------------------

/**
 * アフィリエイト製品ランキングを生成して X に投稿する
 *
 * post-all-slots.ts や x-daily-transfer workflow から呼ぶ。
 * 通常の runSlot() による AI ニュース投稿は一切変更しない。
 *
 * @param xPoster   共有ブラウザセッション（open 済み）
 * @param anthropic Anthropic クライアント
 * @param opts      オプション（dryRun, topN）
 */
export async function postAffiliateRanking(
  xPoster: XPoster,
  anthropic: Anthropic,
  opts: { dryRun?: boolean; topN?: number } = {},
): Promise<void> {
  const { dryRun = false, topN = 3 } = opts;

  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`=== アフィリエイトランキング投稿開始 (TOP${topN}) ${dryRun ? '[DRY-RUN]' : ''} ===`);

  // ① 製品データ読み込み
  const data = loadAffiliateProducts();
  if (!data) {
    logger.warn('[Affiliate] 製品データなし → スキップ');
    return;
  }

  // ② スコアリングで上位 topN を選出
  const ranked = rankProducts(data.products, topN);
  if (ranked.length === 0) {
    logger.warn('[Affiliate] ランキング対象製品なし → スキップ');
    return;
  }

  logger.info(`[Affiliate] ランキング決定:`);
  for (const p of ranked) {
    logger.info(`  ${getRankEmoji(p.rank)}${p.rank}位: ${p.name} (score=${p.score.toFixed(4)})`);
  }

  // ③ 二重投稿チェック（同日・同製品セット）
  const postedCache = new PostedUrlCache(AFFILIATE_CACHE_FILE);
  const cacheKey = buildCacheKey(ranked);
  if (postedCache.has(cacheKey)) {
    logger.info(`[Affiliate] 今日はすでに同じランキングを投稿済み → スキップ (key: ${cacheKey})`);
    return;
  }

  // ④ ツイート文生成
  const rankingTitle = data.rankingTitle ?? `AIガジェット ${data.rankingPeriod}の売れ筋ランキング TOP${ranked.length}`;
  const tweetText = await composeRankingTweet(anthropic, ranked, data.rankingPeriod, rankingTitle);

  logger.info(`[Affiliate] ツイート文 (${tweetText.length}文字):`);
  logger.info(tweetText.slice(0, 200) + (tweetText.length > 200 ? '...' : ''));

  // ⑤ X に投稿
  let success = false;
  if (!dryRun) {
    try {
      success = await xPoster.tweet(tweetText);
      if (success) {
        postedCache.add(cacheKey);
        logger.info('[Affiliate] ✅ 投稿成功');
      } else {
        logger.warn('[Affiliate] ❌ 投稿失敗（XPoster.tweet が false を返した）');
      }
    } catch (err) {
      logger.error(`[Affiliate] 投稿エラー: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    logger.info('[Affiliate] [DRY-RUN] 実際の投稿はスキップ');
    success = true; // dry-run は成功扱い
  }

  // ⑥ アナリティクスログ
  logAnalytics({
    postedAt: new Date().toISOString(),
    slot: 'affiliate',
    platform: 'x',
    theme: 'affiliate_ranking',
    source: 'affiliate-products-json',
    url: ranked[0]?.affiliateUrl ?? '',
    title: rankingTitle,
    imageAttached: false,
    success,
    contentLength: tweetText.length,
  });

  // ⑦ アフィリエイト専用ログ（ダッシュボード用）
  logAffiliatePost({
    postedAt: new Date().toISOString(),
    platform: 'x',
    products: ranked.map(p => ({ rank: p.rank, id: p.id, name: p.name, price: p.price, affiliateUrl: p.affiliateUrl })),
    rankingTitle,
    success,
    dryRun,
  });

  logger.info(`=== アフィリエイトランキング投稿完了 ===\n`);
}

