/**
 * 気休めネタ RSS リーダー
 *
 * カテゴリ: 科学・自然・動物・スポーツ・ほっこり
 * 判定基準: 「いいね」「フーン」「なるほど」「かわいい」と感じるコンテンツ
 * フィルタ: 暴力・アダルト・重事件を除外
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';

export type ReliefCategory = 'science' | 'nature' | 'animal' | 'sports' | 'heartwarming';

export interface ReliefItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: Date;
  imageUrl?: string;
  reliefCategory: ReliefCategory;
  sourceName: string;
}

// ----------------------------------------------------------------
// 安全フィルター（暴力・アダルト・重事件 NG）
// ----------------------------------------------------------------
const NG_KEYWORDS: string[] = [
  // 暴力・事件
  '殺', '死亡', '逮捕', '暴力', '虐待', '死者', '負傷', '訴追', '起訴',
  '犯罪', '強盗', '強制', '暴行', '凶器',
  // 災害・事故
  '地震', '台風', '津波', '洪水', '火災', '爆発', '墜落', '衝突事故',
  // アダルト
  '性的', 'エロ', 'アダルト', 'ヌード', 'セクシュアル',
  // 英語NG
  'murder', 'killed', 'dead body', 'rape', 'sexual assault', 'terror',
  'explosion', 'shooting', 'stabbing', 'porn', 'nude', 'adult content',
  'war crime', 'massacre',
];

function isSafeContent(title: string, summary: string): boolean {
  const text = `${title} ${summary}`.toLowerCase();
  return !NG_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

// ----------------------------------------------------------------
// フィード定義
// ----------------------------------------------------------------
interface ReliefFeedDef {
  name: string;
  feedUrl: string;
  category: ReliefCategory;
}

const RELIEF_FEEDS: ReliefFeedDef[] = [
  // ── 科学 ──
  {
    name: 'sciencedaily_science',
    feedUrl: 'https://www.sciencedaily.com/rss/top/science.xml',
    category: 'science',
  },
  {
    name: 'nhk_science',
    feedUrl: 'https://www3.nhk.or.jp/rss/news/cat6.xml',
    category: 'science',
  },
  {
    name: 'nasa_news',
    feedUrl: 'https://www.nasa.gov/news-release/feed/',
    category: 'nature',
  },

  // ── 自然 ──
  {
    name: 'natgeo',
    feedUrl: 'https://feeds.nationalgeographic.com/ng/News/News_Main',
    category: 'nature',
  },
  {
    name: 'sciencedaily_earth',
    feedUrl: 'https://www.sciencedaily.com/rss/earth_climate/earth.xml',
    category: 'nature',
  },

  // ── 動物・かわいい ──
  {
    name: 'thedodo',
    feedUrl: 'https://www.thedodo.com/rss',
    category: 'animal',
  },
  {
    name: 'sciencedaily_animal',
    feedUrl: 'https://www.sciencedaily.com/rss/plants_animals/animals.xml',
    category: 'animal',
  },

  // ── スポーツ ──
  {
    name: 'nhk_sports',
    feedUrl: 'https://www3.nhk.or.jp/rss/news/cat7.xml',
    category: 'sports',
  },
  {
    name: 'yahoo_sports',
    feedUrl: 'https://news.yahoo.co.jp/rss/sports/index.xml',
    category: 'sports',
  },

  // ── ほっこり・癒し系（日本語） ──
  {
    name: 'grapee',
    feedUrl: 'https://grapee.jp/feed',
    category: 'heartwarming',
  },
  {
    name: 'withnews',
    feedUrl: 'https://withnews.jp/feed',
    category: 'heartwarming',
  },
];

// ----------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48時間（気休めは少し古くてもOK）

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
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('http')) return src;
  return undefined;
}

// ----------------------------------------------------------------
// RSS フェッチ
// ----------------------------------------------------------------
async function fetchReliefFeed(def: ReliefFeedDef): Promise<ReliefItem[]> {
  const res = await axios.get<string>(def.feedUrl, {
    timeout: 12000,
    responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReliefNewsBot/1.0)' },
  });

  const $ = cheerio.load(res.data, { xmlMode: true });
  const cutoff = Date.now() - MAX_AGE_MS;
  const items: ReliefItem[] = [];

  for (const el of $('item, entry').toArray()) {
    const $el = $(el);

    const title = stripHtml($el.find('title').first().text()).trim();
    if (!title) continue;

    const linkEl = $el.find('link').first();
    const url = (
      linkEl.attr('href') ||
      linkEl.text().trim() ||
      $el.find('guid').first().text().trim()
    ).trim();
    if (!url || !url.startsWith('http')) continue;

    const pubStr =
      $el.find('pubDate').text() || $el.find('published').text() ||
      $el.find('updated').text() || $el.find('dc\\:date').text() || '';
    const publishedAt = pubStr ? new Date(pubStr) : new Date();
    if (isNaN(publishedAt.getTime()) || publishedAt.getTime() < cutoff) continue;

    const rawDesc =
      $el.find('description').first().text() ||
      $el.find('content\\:encoded').first().text() ||
      $el.find('content').first().text() ||
      $el.find('summary').first().text() || '';
    const summary = stripHtml(rawDesc).slice(0, 300);

    // 安全フィルター
    if (!isSafeContent(title, summary)) {
      logger.info(`Relief 安全フィルター除外: "${title.slice(0, 40)}"`);
      continue;
    }

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
      imageUrl,
      reliefCategory: def.category,
      sourceName: def.name,
    });
  }

  return items;
}

// ----------------------------------------------------------------
// 公開 API
// ----------------------------------------------------------------

/**
 * 全 Relief RSS フィードを取得し、安全フィルター済みアイテムを返す。
 * 失敗したフィードはスキップ（エラーを throw しない）。
 * カテゴリごとにバランスよく返す。
 */
export async function fetchReliefItems(): Promise<ReliefItem[]> {
  const tasks = RELIEF_FEEDS.map(def =>
    fetchReliefFeed(def)
      .then(items => {
        logger.info(`Relief RSS [${def.name}]: ${items.length} 件取得`);
        return items;
      })
      .catch(err => {
        logger.warn(`Relief RSS [${def.name}] 取得失敗: ${err instanceof Error ? err.message : String(err)}`);
        return [] as ReliefItem[];
      })
  );

  const results = await Promise.allSettled(tasks);
  const allItems = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // 新しい順でソート
  allItems.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  logger.info(`Relief RSS 合計: ${allItems.length} 件 (安全フィルター通過済み)`);
  return allItems;
}
