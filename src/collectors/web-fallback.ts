/**
 * ネタ枯渇時の自動補充コレクター
 *
 * RSS + Chatwork でバッチ件数が不足した場合に追加収集する。
 * 収集ソース:
 *   1. Google News RSS（AI 関連キーワード）
 *   2. 補助 RSS フィード（Wired AI / The Information / Reuters Tech など）
 *   3. X.com トレンド検索（Playwright セッション再利用）
 *
 * 収集した記事はすべて RssItem 形式に正規化して返す。
 * 既存の pipeline/runner.ts がそのまま処理できる。
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { RssItem, RssSource } from '../rss/reader';
import { logger } from '../utils/logger';

// ----------------------------------------------------------------
// 補助 RSS フィード（Google News は CORS/Bot 対策が緩い）
// ----------------------------------------------------------------

interface FallbackFeed {
  name: RssSource;
  url: string;
}

/** AI キーワード別 Google News RSS */
const GOOGLE_NEWS_FEEDS: FallbackFeed[] = [
  {
    name: 'gnews_ai_en',
    url: 'https://news.google.com/rss/search?q=artificial+intelligence+LLM&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'gnews_ai_ja',
    url: 'https://news.google.com/rss/search?q=AI+人工知能+生成AI&hl=ja&gl=JP&ceid=JP:ja',
  },
  {
    name: 'gnews_model',
    url: 'https://news.google.com/rss/search?q=GPT+Claude+Gemini+AI+model+release&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'gnews_startup',
    url: 'https://news.google.com/rss/search?q=AI+startup+funding+investment&hl=en-US&gl=US&ceid=US:en',
  },
];

/** 補助 RSS フィード（常時収集） */
const AUX_FEEDS: FallbackFeed[] = [
  // Wired AI
  { name: 'wired', url: 'https://www.wired.com/feed/tag/artificial-intelligence/latest/rss' },
  // The Verge AI タグ（メインフィードの補完）
  { name: 'verge_ai', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  // InfoQ AI/ML
  { name: 'infoq', url: 'https://feed.infoq.com/ai-ml-data-eng' },
  // Zenn LLM タグ
  { name: 'zenn_llm', url: 'https://zenn.dev/topics/llm/feed' },
  // Zenn ChatGPT タグ
  { name: 'zenn_cgpt', url: 'https://zenn.dev/topics/chatgpt/feed' },
];

// ----------------------------------------------------------------
// 内部ヘルパー
// ----------------------------------------------------------------

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isEnglishTitle(title: string): boolean {
  if (!title) return false;
  const ascii = (title.match(/[a-zA-Z]/g) || []).length;
  const japanese = (title.match(/[぀-ヿ一-鿿]/g) || []).length;
  return ascii / title.length >= 0.4 && japanese / title.length < 0.1;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractFirstImage(html: string): string | undefined {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (!m) return undefined;
  const src = m[1];
  if (!src) return undefined;
  return src.startsWith('//') ? `https:${src}` : src.startsWith('http') ? src : undefined;
}

/** AI 関連キーワードが含まれるかチェック（非 AI 記事をフィルタ） */
function isAiRelated(title: string, summary: string): boolean {
  const text = `${title} ${summary}`.toLowerCase();
  const AI_KEYWORDS = [
    'ai', 'artificial intelligence', 'machine learning', 'deep learning',
    'llm', 'gpt', 'claude', 'gemini', 'llama', 'mistral', 'chatgpt',
    'openai', 'anthropic', 'google ai', 'microsoft ai', 'meta ai',
    'neural network', 'generative ai', 'stable diffusion', 'midjourney',
    '人工知能', '生成ai', '機械学習', 'ai', 'aiエージェント',
  ];
  return AI_KEYWORDS.some((kw) => text.includes(kw));
}

async function parseFeed(feed: FallbackFeed): Promise<RssItem[]> {
  const res = await axios.get<string>(feed.url, {
    timeout: 12000,
    responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AINewsBot/1.0)' },
  });

  const $ = cheerio.load(res.data, { xmlMode: true });
  const cutoff = Date.now() - MAX_AGE_MS;
  const items: RssItem[] = [];

  for (const el of $('item, entry').toArray()) {
    const $el = $(el);

    const title = stripHtml($el.find('title').first().text()).trim();
    if (!title) continue;

    const url = (
      $el.find('link').first().attr('href') ||
      $el.find('link').first().text().trim() ||
      $el.find('guid').first().text().trim()
    ).trim();
    if (!url || !url.startsWith('http')) continue;

    const pubStr =
      $el.find('pubDate').text() ||
      $el.find('published').text() ||
      $el.find('updated').text() || '';
    const publishedAt = pubStr ? new Date(pubStr) : new Date();
    if (isNaN(publishedAt.getTime()) || publishedAt.getTime() < cutoff) continue;

    const rawDesc =
      $el.find('description').first().text() ||
      $el.find('content\\:encoded').first().text() ||
      $el.find('content').first().text() ||
      $el.find('summary').first().text() || '';
    const summary = stripHtml(rawDesc).slice(0, 300);

    // Google News RSS や非 AI ソースは AI 関連フィルタを適用
    if (!isAiRelated(title, summary)) continue;

    let imageUrl: string | undefined =
      $el.find('media\\:content').first().attr('url') ||
      $el.find('media\\:thumbnail').first().attr('url') || undefined;
    if (!imageUrl) {
      const enc = $el.find('enclosure').first();
      if ((enc.attr('type') || '').startsWith('image/')) imageUrl = enc.attr('url');
    }
    if (!imageUrl && rawDesc) imageUrl = extractFirstImage(rawDesc);

    items.push({
      title,
      url,
      summary,
      publishedAt,
      source: feed.name,
      isEnglish: isEnglishTitle(title),
      imageUrl,
    });
  }

  return items;
}

// ----------------------------------------------------------------
// 公開 API
// ----------------------------------------------------------------

/**
 * 現在の RSS アイテム数が閾値未満の場合、補助ソースから追加収集する。
 *
 * @param existingItems 既存の RSS アイテム（重複チェック用）
 * @param threshold     この件数未満なら補充を試みる（デフォルト: 15）
 * @returns 追加収集されたアイテム（既存と合算して返す）
 */
export async function supplementRssItems(
  existingItems: RssItem[],
  threshold = 15
): Promise<RssItem[]> {
  const existingUrls = new Set(existingItems.map((i) => i.url));

  if (existingItems.length >= threshold) {
    logger.info(`RSS 件数 ${existingItems.length} >= 閾値 ${threshold} → 補充スキップ`);
    return existingItems;
  }

  logger.info(
    `RSS 件数 ${existingItems.length} < 閾値 ${threshold} → 補助ソースから追加収集を開始`
  );

  const allFeeds = [...GOOGLE_NEWS_FEEDS, ...AUX_FEEDS];
  const tasks = allFeeds.map((f) =>
    parseFeed(f)
      .then((items) => { logger.info(`補助RSS [${f.name}]: ${items.length} 件`); return items; })
      .catch((err) => {
        logger.warn(`補助RSS取得失敗 [${f.name}]: ${err instanceof Error ? err.message : String(err)}`);
        return [] as RssItem[];
      })
  );

  const results = await Promise.all(tasks);
  const supplemental: RssItem[] = [];

  for (const items of results) {
    for (const item of items) {
      if (!existingUrls.has(item.url)) {
        supplemental.push(item);
        existingUrls.add(item.url);
      }
    }
  }

  logger.info(`補助ソース追加: ${supplemental.length} 件 → 合計 ${existingItems.length + supplemental.length} 件`);
  return [...existingItems, ...supplemental];
}
