/**
 * note 誘導ツイート（施策E）
 *
 * 週 2 回（水・金 18:00 JST）に note のアフィリエイト記事へ誘導するツイートを投稿する。
 *
 * 【なぜ必要か】
 *   X のアフィリエイトリンクはクリック率が低い（怪しい短縮 URL に見える）。
 *   note の記事リンクは信頼されクリックされやすく、記事内で楽天リンクを自然に踏める。
 *   この「X → note → 楽天」の橋渡しをするのが誘導ツイートの役割。
 *
 * 【設定】
 *   NOTE_CTA_URL: 誘導先の note 記事 URL（.env に設定）
 *               未設定の場合は data/note-affiliate-article.json から読む
 *
 * 【投稿タイミング】
 *   水曜 18:00 JST (UTC 09:00) — x-note-cta-wed
 *   金曜 18:00 JST (UTC 09:00) — x-note-cta-fri
 */
import Anthropic from '@anthropic-ai/sdk';
import { XPoster } from './poster';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

// 誘導先 URL を解決する
const ARTICLE_CACHE_FILE = path.join(process.cwd(), 'data', 'note-affiliate-article.json');

interface ArticleCache {
  url: string;
  title: string;
  publishedAt: string;
}

export function resolveNoteCtaUrl(): string | null {
  // 優先順位1: 環境変数
  if (process.env['NOTE_CTA_URL']) {
    return process.env['NOTE_CTA_URL'];
  }

  // 優先順位2: 施策G が書き込むキャッシュファイル
  try {
    if (fs.existsSync(ARTICLE_CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(ARTICLE_CACHE_FILE, 'utf-8')) as ArticleCache;
      if (cache.url && cache.url !== 'https://note.com/dry-run') {
        return cache.url;
      }
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * アフィリ商品リストから note 誘導ツイートを Claude で生成する
 */
export async function generateNoteCtaTweet(
  anthropic: Anthropic,
  noteUrl: string,
  products: Array<{ name: string; highlight: string }>,
): Promise<string> {
  const productLines = products
    .slice(0, 3)
    .map((p, i) => `${['1️⃣', '2️⃣', '3️⃣'][i]} ${p.name}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `以下の AI ガジェットランキング情報をもとに、X（Twitter）への note 誘導ツイートを書いてください。

【掲載商品】
${productLines}

【note 記事 URL】
${noteUrl}

【条件】
- 日本語で 130 文字以内（URL 含む）
- 読んでみたくなる書き出し（例: 「今月使って良かった...」「AI 作業が捗る...」）
- 商品名を 3 件列挙（絵文字付き）
- 「楽天で全部揃います」「詳細は note で」などの自然な CTA
- URL をツイート末尾に入れる
- ハッシュタグは 1〜2 個のみ（#AIガジェット #楽天 どちらか）

ツイート本文のみ出力（前置きなし）:`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return text.trim();
}

export interface NoteCtaResult {
  success: boolean;
  noteUrl: string | null;
  tweetText: string | null;
}

/**
 * note 誘導ツイートを投稿する
 */
export async function postNoteCtaTweet(
  poster: XPoster,
  anthropic: Anthropic,
  opts: { dryRun?: boolean } = {},
): Promise<NoteCtaResult> {
  const { dryRun = false } = opts;

  // 誘導先 URL を解決
  const noteUrl = resolveNoteCtaUrl();
  if (!noteUrl) {
    logger.warn(
      '[note-cta] 誘導先 URL が未設定です。' +
      '.env に NOTE_CTA_URL を設定するか、先に施策G（note SEO記事）を実行してください。',
    );
    return { success: false, noteUrl: null, tweetText: null };
  }

  logger.info(`[note-cta] 誘導先 URL: ${noteUrl}`);

  // アフィリエイト商品リストを読み込む
  let products: Array<{ name: string; highlight: string }> = [];
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'data', 'affiliate-products.json'), 'utf-8'),
    ) as { products: Array<{ name: string; highlight: string; disabled?: boolean }> };
    products = data.products.filter((p) => !p.disabled).slice(0, 3);
  } catch {
    products = [
      { name: 'PLAUD NotePin S', highlight: 'AI ボイスレコーダー' },
      { name: 'MacBook Air M4', highlight: 'ローカル LLM 対応' },
      { name: 'Anker 160W 充電器', highlight: 'デスク整理の必需品' },
    ];
  }

  // ツイート生成
  logger.info('[note-cta] Claude でツイートを生成中...');
  const tweetText = await generateNoteCtaTweet(anthropic, noteUrl, products).catch((err) => {
    logger.warn(
      `[note-cta] Claude 生成失敗: ${err instanceof Error ? err.message : String(err)}`,
    );
    // フォールバック: テンプレート
    const lines = products
      .slice(0, 3)
      .map((p, i) => `${['1️⃣', '2️⃣', '3️⃣'][i]} ${p.name}`)
      .join('\n');
    return `今月使って良かった AI ガジェット TOP3 を note にまとめました📝\n\n${lines}\n\n楽天で全部揃います👇\n${noteUrl}`;
  });

  logger.info(`[note-cta] 生成ツイート:\n${tweetText}`);

  if (dryRun) {
    logger.info('[note-cta] [DRY-RUN] 投稿をスキップしました');
    return { success: true, noteUrl, tweetText };
  }

  const ok = await poster.tweet(tweetText);
  if (ok) {
    logger.info('[note-cta] ✅ note 誘導ツイート投稿完了');
  }
  return { success: ok, noteUrl, tweetText };
}
