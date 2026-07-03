/**
 * Reddit トレンドリサーチャー
 *
 * Reddit の公開 Atom/RSS フィード（認証不要）から AI/ML/Tech 関連スレッドの
 * トレンドを取得し、RssItem 形式に変換する。
 *
 * 参考: @mikefutia の Claude Code content research plugin コンセプト
 * （Apify/Firecrawl の代わりに Reddit 公開 RSS Feed を使用）
 *
 * 対象 subreddit:
 *   r/artificial, r/MachineLearning, r/ChatGPT, r/LocalLLaMA,
 *   r/singularity, r/OpenAI, r/LanguageTechnology
 *
 * 使い方:
 *   const items = await fetchRedditTrends('slot12', 5);
 *   // → 論文・研究系スレッドを最大5件返す
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { SlotName, XCategory } from '../utils/x-category';
import { RssItem, RssSource } from './reader';
import { logger } from '../utils/logger';

// ── subreddit 定義 ────────────────────────────────────────────────

interface SubredditDef {
  name: string;
  preferredSlot?: SlotName;
  /** 取得するタイムフレーム */
  timeframe: 'day' | 'week';
  /** この subreddit の投稿のデフォルトカテゴリ */
  defaultCategory?: XCategory;
}

const AI_SUBREDDITS: SubredditDef[] = [
  // 全スロット共通（汎用 AI ニュース）
  { name: 'artificial',        timeframe: 'day' },
  { name: 'ChatGPT',           timeframe: 'day' },
  { name: 'singularity',       timeframe: 'day' },
  // slot11 向け（新モデル・AI ツール）
  { name: 'OpenAI',            timeframe: 'day',  preferredSlot: 'slot11', defaultCategory: 'model_release' },
  // slot12 向け（論文・研究）
  { name: 'MachineLearning',   timeframe: 'day',  preferredSlot: 'slot12', defaultCategory: 'paper' },
  { name: 'LanguageTechnology', timeframe: 'week', preferredSlot: 'slot12', defaultCategory: 'research_method' },
  // slot17 向け（開発・OSS）
  { name: 'LocalLLaMA',        timeframe: 'day',  preferredSlot: 'slot17', defaultCategory: 'opensource' },
];

// ── Atom フィードのパーサー ────────────────────────────────────────

interface ParsedEntry {
  title: string;
  link: string;
  summary: string;
  published: Date;
  imageUrl?: string;
}

function parseAtomFeed(xml: string): ParsedEntry[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const entries: ParsedEntry[] = [];

  $('entry').each((_, el) => {
    const title   = $(el).find('title').first().text().trim();
    const link    = $(el).find('link[rel="alternate"]').attr('href') ||
                    $(el).find('link').first().attr('href') || '';
    const summary = $(el).find('summary').text().replace(/<[^>]*>/g, ' ').trim().slice(0, 200);
    const publishedStr = $(el).find('published').text() || $(el).find('updated').text();
    const published = publishedStr ? new Date(publishedStr) : new Date();

    // サムネイル（media:thumbnail）
    const imageUrl = $(el).find('thumbnail').attr('url') ||
                     $(el).find('media\\:thumbnail').attr('url') ||
                     undefined;

    if (title && link) {
      entries.push({ title, link, summary, published, imageUrl });
    }
  });

  return entries;
}

// ── メイン取得関数 ────────────────────────────────────────────────

/**
 * 指定スロット（または全スロット）向けのトレンド投稿を取得する。
 *
 * @param targetSlot スロット指定（省略時は全スレッド対象）
 * @param limitPerSubreddit 1スレッドあたりの最大取得件数
 * @returns エンゲージメント上位の RssItem 配列
 */
export async function fetchRedditTrends(
  targetSlot?: SlotName,
  limitPerSubreddit = 5,
): Promise<RssItem[]> {
  const targets = targetSlot
    ? AI_SUBREDDITS.filter(
        (s) => s.preferredSlot === targetSlot || s.preferredSlot === undefined
      )
    : AI_SUBREDDITS;

  const allItems: RssItem[] = [];
  const seenUrls = new Set<string>();

  await Promise.allSettled(
    targets.map(async (sub) => {
      try {
        // Reddit Atom フィード（Top / 時間帯別）
        const feedUrl =
          `https://www.reddit.com/r/${sub.name}/top/.rss` +
          `?t=${sub.timeframe}&limit=${limitPerSubreddit * 2}`;

        const res = await axios.get<string>(feedUrl, {
          timeout: 12000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/atom+xml,application/xml,text/xml',
          },
        });

        const entries = parseAtomFeed(res.data);
        logger.info(`[Reddit] r/${sub.name}: ${entries.length} 件取得 (${sub.timeframe})`);

        const added = entries.slice(0, limitPerSubreddit).filter((entry) => {
          if (seenUrls.has(entry.link)) return false;
          seenUrls.add(entry.link);
          return true;
        });

        for (const entry of added) {
          allItems.push({
            title: entry.title,
            url: entry.link,
            summary: entry.summary || entry.title,
            publishedAt: entry.published,
            source: 'reddit' as RssSource,
            isEnglish: true, // Reddit は基本英語
            imageUrl: entry.imageUrl,
            preferredSlot: sub.preferredSlot,
          });
        }
      } catch (err) {
        logger.warn(
          `[Reddit] r/${sub.name} 取得失敗: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  logger.info(`[Reddit] トレンド取得完了: ${allItems.length} 件`);
  return allItems;
}

/**
 * Reddit アイテムのサマリー（デバッグ・ログ用）。
 */
export function formatRedditSummary(items: RssItem[]): string {
  return items
    .slice(0, 5)
    .map((item, i) => `  ${i + 1}. [${item.source}] ${item.title.slice(0, 60)}`)
    .join('\n');
}
