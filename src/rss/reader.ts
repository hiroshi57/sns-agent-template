/**
 * RSS フィードリーダー
 *
 * 共通ソース（全スロット）:
 *   TechCrunch AI / The Verge / MIT Tech Review / VentureBeat / Zenn AI / HN
 *
 * スロット別専用ソース:
 *   slot07 (07:30 通勤) : Forbes AI / Business Insider Tech / Nikkei AI
 *   slot11 (11:00 新モデル): OpenAI Blog / Anthropic Blog / Google AI Blog
 *   slot12 (12:00 論文・研究): arXiv cs.AI / DeepMind Blog / Papers With Code
 *   slot14 (14:00 規制・倫理): Reuters Tech / Wired AI / AI Policy
 *   slot17 (17:00 開発・OSS) : GitHub Blog / InfoQ AI / Qiita AI / HuggingFace
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { SlotName } from '../utils/x-category';
import { logger } from '../utils/logger';
import { rssHealthTracker } from '../utils/rss-health-tracker';

export type RssSource =
  | 'techcrunch' | 'verge' | 'mit' | 'venturebeat' | 'zenn' | 'hn'
  // 共通: 日本語補完（#53追加）
  | 'itmedia' | 'gigazine'
  // slot07: ビジネス・スタートアップ
  | 'openai' | 'anthropic' | 'googleai' | 'deepmind'
  | 'forbes' | 'bistech' | 'wsj_tech' | 'nikkei_ai' | 'cbinsights'
  // slot11: 新モデル・AIツール・画像動画AI
  | 'microsoft_ai' | 'meta_ai' | 'nvidia_blog' | 'aws_ml' | 'producthunt_ai'
  | 'stability_ai' | 'the_decoder' | 'ars_technica' | 'adobe_ai'
  // slot11: 追加LLMプロバイダー（#53追加）
  | 'mistral_ai' | 'cohere'
  // slot12: 論文・研究・データ
  | 'arxiv' | 'paperswithcode' | 'distill' | 'ai2blog' | 'mlmastery'
  // slot12: RAG・エージェント研究（#53追加）
  | 'llamaindex' | 'sakana_ai'
  // slot14: 規制・倫理・カンファレンス
  | 'reuters' | 'wired' | 'aiindex' | 'oecd_ai' | 'futureoflife' | 'aisnakeoil'
  // slot17: 開発・実装・OSS
  | 'github' | 'infoq' | 'qiita' | 'huggingface' | 'zenn_llm' | 'devto_ai' | 'pytorch' | 'ollama_blog'
  // slot17: エージェント実装フレームワーク（#53追加）
  | 'langchain'
  // web-fallback: 補助ソース
  | 'gnews_ai_en' | 'gnews_ai_ja' | 'gnews_model' | 'gnews_startup'
  | 'verge_ai' | 'zenn_cgpt' | 'chatwork'
  // トレンドリサーチ
  | 'reddit';

export interface RssItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: Date;
  source: RssSource;
  /** タイトルが英語かどうか（tweet-composer の英語フォーマット適用判定） */
  isEnglish: boolean;
  /** og:image 相当の画像 URL（なければ undefined） */
  imageUrl?: string;
  /** このアイテムが得意なスロット（指定なければ全スロット対象） */
  preferredSlot?: SlotName;
}

interface FeedDef {
  name: RssSource;
  feedUrl: string;
  /** 得意スロット（省略時は全スロット共通） */
  preferredSlot?: SlotName;
}

// ----------------------------------------------------------------
// 共通フィード（全スロット）
// ----------------------------------------------------------------
const RSS_FEEDS: FeedDef[] = [
  {
    name: 'techcrunch',
    feedUrl: 'https://techcrunch.com/category/artificial-intelligence/feed/',
  },
  {
    name: 'verge',
    feedUrl: 'https://www.theverge.com/rss/index.xml',
  },
  {
    name: 'mit',
    feedUrl: 'https://www.technologyreview.com/feed/',
  },
  {
    name: 'venturebeat',
    feedUrl: 'https://venturebeat.com/feed/',
  },
  {
    name: 'zenn',
    feedUrl: 'https://zenn.dev/topics/ai/feed',
  },
  // ── 日本語補完ソース（#53追加: 朝の共通取得でカバレッジ向上）──
  {
    name: 'itmedia',
    feedUrl: 'https://rss.itmedia.co.jp/rss/2.0/aiplus.xml',
  },
  {
    name: 'gigazine',
    feedUrl: 'https://gigazine.net/news/rss_2.0/',
  },
];

// ----------------------------------------------------------------
// スロット別専用フィード
// ----------------------------------------------------------------
const SLOT_FEEDS: FeedDef[] = [

  // ── slot07: 通勤サラリーマン向け（ビジネス・トレンド・スタートアップ）──
  // 既存
  { name: 'forbes',   feedUrl: 'https://www.forbes.com/innovation/feed/',             preferredSlot: 'slot07' },
  { name: 'bistech',  feedUrl: 'https://feeds.businessinsider.com/custom/tech',        preferredSlot: 'slot07' },
  // 追加
  { name: 'wsj_tech',   feedUrl: 'https://feeds.content.dowjones.io/public/rss/RSSWSJD', preferredSlot: 'slot07' },
  { name: 'cbinsights', feedUrl: 'https://www.cbinsights.com/research/feed/',            preferredSlot: 'slot07' },
  { name: 'nikkei_ai',  feedUrl: 'https://www.nikkei.com/rss/news.rdf',                  preferredSlot: 'slot07' },

  // ── slot11: 新モデル・AIツール・ロードマップ ──
  // 既存
  { name: 'openai',    feedUrl: 'https://openai.com/news/rss.xml',          preferredSlot: 'slot11' },
  { name: 'anthropic', feedUrl: 'https://www.anthropic.com/rss.xml',        preferredSlot: 'slot11' },
  { name: 'googleai',  feedUrl: 'https://blog.google/technology/ai/rss/',   preferredSlot: 'slot11' },
  // 追加
  { name: 'microsoft_ai',  feedUrl: 'https://blogs.microsoft.com/ai/feed/',                     preferredSlot: 'slot11' },
  { name: 'meta_ai',       feedUrl: 'https://ai.meta.com/blog/feed/',                           preferredSlot: 'slot11' },
  { name: 'nvidia_blog',   feedUrl: 'https://blogs.nvidia.com/feed/',                           preferredSlot: 'slot11' },
  { name: 'aws_ml',        feedUrl: 'https://aws.amazon.com/blogs/machine-learning/feed/',      preferredSlot: 'slot11' },
  { name: 'producthunt_ai', feedUrl: 'https://www.producthunt.com/feed?category=artificial-intelligence', preferredSlot: 'slot11' },
  // 追加: 画像・動画AI 専門ソース（image_video_ai カテゴリ充足のため）
  { name: 'stability_ai',  feedUrl: 'https://stability.ai/news/rss.xml',                                  preferredSlot: 'slot11' },
  { name: 'the_decoder',   feedUrl: 'https://the-decoder.com/feed/',                                      preferredSlot: 'slot11' },
  { name: 'ars_technica',  feedUrl: 'https://feeds.arstechnica.com/arstechnica/technology-lab',           preferredSlot: 'slot11' },
  { name: 'adobe_ai',      feedUrl: 'https://blog.adobe.com/en/topics/ai-and-innovation/rss-feed',        preferredSlot: 'slot11' },
  // #53追加: model_release / model_roadmap 充足のため
  { name: 'mistral_ai',    feedUrl: 'https://mistral.ai/news/rss.xml',                                    preferredSlot: 'slot11' },
  { name: 'cohere',        feedUrl: 'https://cohere.com/blog/feed',                                       preferredSlot: 'slot11' },

  // ── slot12: 論文・研究・データ・統計 ──
  // 既存
  { name: 'arxiv',         feedUrl: 'https://rss.arxiv.org/rss/cs.AI+cs.LG',  preferredSlot: 'slot12' },
  { name: 'deepmind',      feedUrl: 'https://deepmind.google/blog/rss.xml',    preferredSlot: 'slot12' },
  { name: 'paperswithcode', feedUrl: 'https://paperswithcode.com/rss.xml',     preferredSlot: 'slot12' },
  // 追加
  { name: 'ai2blog',   feedUrl: 'https://blog.allenai.org/feed',                                      preferredSlot: 'slot12' },
  { name: 'distill',   feedUrl: 'https://distill.pub/rss.xml',                                        preferredSlot: 'slot12' },
  { name: 'mlmastery', feedUrl: 'https://machinelearningmastery.com/blog/feed/',                      preferredSlot: 'slot12' },
  // #53追加: rag_search カテゴリ充足のため
  { name: 'llamaindex', feedUrl: 'https://www.llamaindex.ai/blog/rss.xml',                            preferredSlot: 'slot12' },
  { name: 'sakana_ai',  feedUrl: 'https://sakana.ai/blog/rss.xml',                                    preferredSlot: 'slot12' },

  // ── slot14: 規制・倫理・政策・カンファレンス ──
  // 既存
  { name: 'reuters',  feedUrl: 'https://feeds.reuters.com/reuters/technologyNews',                      preferredSlot: 'slot14' },
  { name: 'wired',    feedUrl: 'https://www.wired.com/feed/tag/artificial-intelligence/latest/rss',     preferredSlot: 'slot14' },
  // 追加
  { name: 'aiindex',      feedUrl: 'https://aiindex.stanford.edu/feed/',                               preferredSlot: 'slot14' },
  { name: 'futureoflife', feedUrl: 'https://futureoflife.org/feed/',                                   preferredSlot: 'slot14' },
  { name: 'oecd_ai',      feedUrl: 'https://oecd.ai/en/feed',                                         preferredSlot: 'slot14' },
  { name: 'aisnakeoil',   feedUrl: 'https://www.aisnakeoil.com/feed',                                  preferredSlot: 'slot14' },

  // ── slot17: 開発・実装・OSS・エンジニア ──
  // 既存
  { name: 'github',      feedUrl: 'https://github.blog/feed/',                  preferredSlot: 'slot17' },
  { name: 'infoq',       feedUrl: 'https://feed.infoq.com/ai-ml-data-eng',      preferredSlot: 'slot17' },
  { name: 'qiita',       feedUrl: 'https://qiita.com/tags/ai/feed',             preferredSlot: 'slot17' },
  { name: 'huggingface', feedUrl: 'https://huggingface.co/blog/feed.xml',       preferredSlot: 'slot17' },
  // 追加
  { name: 'zenn_llm',    feedUrl: 'https://zenn.dev/topics/llm/feed',           preferredSlot: 'slot17' },
  { name: 'devto_ai',    feedUrl: 'https://dev.to/feed/tag/ai',                 preferredSlot: 'slot17' },
  { name: 'pytorch',     feedUrl: 'https://pytorch.org/blog/feed.xml',          preferredSlot: 'slot17' },
  { name: 'ollama_blog', feedUrl: 'https://ollama.com/blog/rss',                preferredSlot: 'slot17' },
  // #53追加: agent カテゴリ充足のため
  { name: 'langchain',   feedUrl: 'https://blog.langchain.dev/rss/',            preferredSlot: 'slot17' },
];

const HN_API =
  'https://hn.algolia.com/api/v1/search_by_date' +
  '?tags=story&query=artificial+intelligence+LLM+machine+learning&hitsPerPage=30';
const HN_ITEM_BASE = 'https://news.ycombinator.com/item?id=';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 時間

// ----------------------------------------------------------------
// 内部ヘルパー
// ----------------------------------------------------------------

/** タイトルが英語かどうかを判定（tweet-composer.ts と同じロジック） */
function isEnglishTitle(title: string): boolean {
  if (!title || title.length === 0) return false;
  const ascii = (title.match(/[a-zA-Z]/g) || []).length;
  const japanese = (title.match(/[぀-ヿ一-鿿]/g) || []).length;
  return ascii / title.length >= 0.4 && japanese / title.length < 0.1;
}

/** HTML タグ・エンティティを除去してプレーンテキスト化 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** HTML 文字列から最初の <img src> を取得 */
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
// RSS / Atom フィード取得
// ----------------------------------------------------------------

async function fetchRssFeed(def: FeedDef): Promise<RssItem[]> {
  const res = await axios.get<string>(def.feedUrl, {
    timeout: 15000,
    responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AINewsBot/1.0)' },
  });

  const $ = cheerio.load(res.data, { xmlMode: true });
  const cutoff = Date.now() - MAX_AGE_MS;
  const items: RssItem[] = [];

  // RSS 2.0: <item>  /  Atom: <entry>
  const elements = $('item, entry').toArray();

  for (const el of elements) {
    const $el = $(el);

    // ── タイトル ──
    const title = stripHtml($el.find('title').first().text()).trim();
    if (!title) continue;

    // ── URL ──
    // Atom: <link href="..." rel="alternate"/>  /  RSS: <link> テキスト or <guid>
    const linkEl = $el.find('link').first();
    const url = (
      linkEl.attr('href') ||
      linkEl.text().trim() ||
      $el.find('guid').first().text().trim()
    ).trim();
    if (!url || !url.startsWith('http')) continue;

    // ── 投稿日時 ──
    const pubStr =
      $el.find('pubDate').text() ||
      $el.find('published').text() ||
      $el.find('updated').text() ||
      $el.find('dc\\:date').text() ||
      '';
    const publishedAt = pubStr ? new Date(pubStr) : new Date();
    if (isNaN(publishedAt.getTime())) continue;
    if (publishedAt.getTime() < cutoff) continue;

    // ── 概要 / 本文 ──
    const rawDesc =
      $el.find('description').first().text() ||
      $el.find('content\\:encoded').first().text() ||
      $el.find('content').first().text() ||
      $el.find('summary').first().text() ||
      '';
    const summary = stripHtml(rawDesc).slice(0, 300);

    // ── 画像 URL（優先順位: media:content > media:thumbnail > enclosure > <img> in desc） ──
    let imageUrl: string | undefined =
      $el.find('media\\:content').first().attr('url') ||
      $el.find('media\\:thumbnail').first().attr('url') ||
      undefined;

    if (!imageUrl) {
      const enc = $el.find('enclosure').first();
      const encType = enc.attr('type') || '';
      if (encType.startsWith('image/')) imageUrl = enc.attr('url');
    }

    if (!imageUrl && rawDesc) {
      imageUrl = extractFirstImage(rawDesc);
    }

    items.push({
      title,
      url,
      summary,
      publishedAt,
      source: def.name,
      isEnglish: isEnglishTitle(title),
      imageUrl,
    });
  }

  return items;
}

// ----------------------------------------------------------------
// HN Algolia API
// ----------------------------------------------------------------

async function fetchHnItems(): Promise<RssItem[]> {
  const cutoff = Date.now() - MAX_AGE_MS;

  const res = await axios.get<{
    hits: Array<{
      objectID: string;
      title: string;
      url?: string;
      created_at: string;
      story_text?: string;
      points?: number;
    }>;
  }>(HN_API, { timeout: 15000 });

  return res.data.hits
    .filter((h) => {
      const t = new Date(h.created_at).getTime();
      return !isNaN(t) && t > cutoff && (h.points ?? 0) >= 5;
    })
    .map((h) => ({
      title: h.title,
      url: h.url?.startsWith('http')
        ? h.url
        : `${HN_ITEM_BASE}${h.objectID}`,
      summary: stripHtml(h.story_text || '').slice(0, 300),
      publishedAt: new Date(h.created_at),
      source: 'hn' as const,
      isEnglish: isEnglishTitle(h.title),
      imageUrl: undefined,
    }));
}

// ----------------------------------------------------------------
// 公開 API
// ----------------------------------------------------------------

/**
 * スロット指定で RSS アイテムを取得する。
 * 共通ソース + そのスロット専用ソースを並列取得し、
 * preferredSlot が一致するアイテムを先頭に並べて返す。
 *
 * @param slot 実行スロット名（省略時は共通ソースのみ）
 */
export async function fetchAllRssItems(slot?: SlotName): Promise<RssItem[]> {
  // スロット専用フィードを選択（共通ソースと当該スロット専用ソース）
  const slotFeeds = slot
    ? SLOT_FEEDS.filter((f) => f.preferredSlot === slot)
    : [];
  const allFeeds = [...RSS_FEEDS, ...slotFeeds];

  const tasks = [
    ...allFeeds.map((def) => {
      // 死亡中ソースはスキップ (#41)
      if (rssHealthTracker.isDead(def.name)) {
        logger.info(`RSS スキップ（死亡判定）: [${def.name}]`);
        return Promise.resolve({ name: def.name, items: [] as RssItem[] });
      }
      return fetchRssFeed(def)
        .then((items) => {
          rssHealthTracker.record(def.name, true);
          // preferredSlot を各アイテムに付与
          const tagged = items.map((item) => ({
            ...item,
            preferredSlot: def.preferredSlot,
          }));
          return { name: def.name, items: tagged };
        })
        .catch((err) => {
          rssHealthTracker.record(def.name, false);
          logger.warn(
            `RSS取得失敗 [${def.name}]: ${err instanceof Error ? err.message : String(err)}`
          );
          return { name: def.name, items: [] as RssItem[] };
        });
    }),
    fetchHnItems()
      .then((items) => ({ name: 'hn' as RssSource, items }))
      .catch((err) => {
        logger.warn(
          `HN取得失敗: ${err instanceof Error ? err.message : String(err)}`
        );
        return { name: 'hn' as RssSource, items: [] as RssItem[] };
      }),
  ];

  const results = await Promise.all(tasks);
  const allItems: RssItem[] = [];

  for (const { name, items } of results) {
    logger.info(`RSS [${name}]: ${items.length} 件取得`);
    allItems.push(...items);
  }

  // スロット専用ソースのアイテムを先頭に、その後は新しい順でソート
  allItems.sort((a, b) => {
    const aIsSlot = a.preferredSlot === slot ? 1 : 0;
    const bIsSlot = b.preferredSlot === slot ? 1 : 0;
    if (aIsSlot !== bIsSlot) return bIsSlot - aIsSlot;
    return b.publishedAt.getTime() - a.publishedAt.getTime();
  });

  // 死活状態を保存 (#41)
  rssHealthTracker.save();

  logger.info(`RSS 合計: ${allItems.length} 件 (スロット: ${slot ?? '共通'})`);
  return allItems;
}
