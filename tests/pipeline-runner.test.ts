/**
 * pipeline/runner.ts の buildSlotBatch と titleSimilarity のユニットテスト
 */
import { buildSlotBatch, titleSimilarity, isCrossSlotDuplicate } from '../src/pipeline/runner';
import { PostedUrlCache } from '../src/utils/posted-url-cache';
import { RssItem } from '../src/rss/reader';
import { ArticleContent } from '../src/scraper/article';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── titleSimilarity のテスト ──────────────────────────────────────────

describe('titleSimilarity', () => {
  test('まったく同じタイトルは 1.0', () => {
    const s = titleSimilarity('OpenAI releases GPT-5', 'OpenAI releases GPT-5');
    expect(s).toBeCloseTo(1.0, 1);
  });

  test('まったく異なるタイトルは低い値', () => {
    const s = titleSimilarity('OpenAI releases GPT-5', 'Japan election results');
    expect(s).toBeLessThan(0.2);
  });

  test('ほぼ同じタイトルは高い類似度', () => {
    const a = 'Anthropic releases Claude 4 with improved reasoning';
    const b = 'Anthropic releases Claude 4 featuring improved reasoning';
    expect(titleSimilarity(a, b)).toBeGreaterThan(0.6);
  });

  test('日本語のほぼ同じタイトルも高い類似度', () => {
    const a = 'ChatGPTが新機能を発表、日本語対応を強化';
    const b = 'ChatGPTが新機能発表、日本語対応を強化へ';
    expect(titleSimilarity(a, b)).toBeGreaterThan(0.5);
  });

  test('空文字列は 0', () => {
    expect(titleSimilarity('', 'OpenAI')).toBe(0);
    expect(titleSimilarity('OpenAI', '')).toBe(0);
  });
});

// ── isCrossSlotDuplicate のテスト ────────────────────────────────────

describe('isCrossSlotDuplicate', () => {
  test('Sol/Terra/Luna 等の製品名 2件以上共有で重複判定', () => {
    const prev = 'Sol/Terra/Luna tiered AI platform announced by competitor';
    const next = 'Sol/Terra/Luna pricing model enables small business adoption';
    expect(isCrossSlotDuplicate(next, prev)).toBe(true);
  });

  test('1件しか共有しない場合は重複判定しない（OpenAI 系記事の誤検知防止）', () => {
    const prev = 'OpenAI releases GPT-5 with improved reasoning';
    const next = 'OpenAI announces new ChatGPT voice feature';
    // 共有: "openai" の 1 件のみ → 重複判定しない
    expect(isCrossSlotDuplicate(next, prev)).toBe(false);
  });

  test('全く無関係な記事は重複判定しない', () => {
    const prev = 'Anthropic publishes AI safety research paper';
    const next = 'Google announces Gemini Ultra 2 for enterprise customers';
    expect(isCrossSlotDuplicate(next, prev)).toBe(false);
  });

  test('日英混在タイトルでも固有名詞 2件共有で重複判定', () => {
    const prev = 'Gemini Ultra benchmark shows Claude Sonnet performance comparison';
    const next = 'Gemini Ultra outperforms Claude Sonnet in reasoning tasks';
    // 共有: "gemini", "ultra", "claude", "sonnet" → 4件 → 重複
    expect(isCrossSlotDuplicate(next, prev)).toBe(true);
  });
});

// ── buildSlotBatch のテスト ───────────────────────────────────────────

const TMP_DIR = path.join(os.tmpdir(), `pipeline-test-${Date.now()}`);
const CACHE_FILE = path.join(TMP_DIR, 'posted.json');

function makeRssItem(overrides: Partial<RssItem> = {}): RssItem {
  return {
    title: 'OpenAI launches new AI model with better performance',
    url: `https://example.com/${Math.random()}`,
    summary: 'A new AI model has been released',
    publishedAt: new Date(),
    source: 'techcrunch',
    isEnglish: true,
    imageUrl: undefined,
    ...overrides,
  };
}

function makeArticle(overrides: Partial<ArticleContent> = {}): ArticleContent {
  return {
    url: `https://chatwork.example.com/${Math.random()}`,
    title: 'AI最新ニュース',
    summary: 'AIに関するニュースです',
    thumbnailUrl: '',
    body: 'AIに関する詳細な情報',
    isValid: true,
    ...overrides,
  };
}

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: 1, entries: [] }));
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('buildSlotBatch', () => {
  test('RSS アイテムがある場合にバッチを返す', () => {
    const cache = new PostedUrlCache(CACHE_FILE);
    const rssItems = [
      makeRssItem({ title: 'OpenAI releases GPT-5 with advanced reasoning' }),
      makeRssItem({ title: 'Google announces Gemini Ultra 2 for enterprise' }),
      makeRssItem({ title: 'Anthropic Claude 4 improves coding capabilities' }),
      makeRssItem({ title: 'Meta releases Llama 3 open source model' }),
    ];

    const batch = buildSlotBatch('slot11', rssItems, [], cache);
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThanOrEqual(4);
  });

  test('投稿済み URL はバッチに含まれない', () => {
    const url = 'https://example.com/already-posted';
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      version: 1,
      entries: [{ url, postedAt: new Date().toISOString() }],
    }));
    const cache = new PostedUrlCache(CACHE_FILE);

    const rssItems = [makeRssItem({ url })];
    const batch = buildSlotBatch('slot11', rssItems, [], cache);
    const found = batch.find(b => b.url === url);
    expect(found).toBeUndefined();
  });

  test('重複タイトルは片方だけバッチに含まれる', () => {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: 1, entries: [] }));
    const cache = new PostedUrlCache(CACHE_FILE);

    const title = 'OpenAI releases GPT-5 model with improved performance';
    const rssItems = [
      makeRssItem({ title, url: 'https://example.com/gpt5-a' }),
      makeRssItem({
        title: 'OpenAI releases GPT-5 model improved performance new',
        url: 'https://example.com/gpt5-b',
      }),
    ];

    const batch = buildSlotBatch('slot11', rssItems, [], cache);
    // 類似度が高いので片方しか選ばれないはず
    const count = batch.filter(b =>
      b.url === 'https://example.com/gpt5-a' ||
      b.url === 'https://example.com/gpt5-b'
    ).length;
    expect(count).toBeLessThanOrEqual(1);
  });

  test('アイテムが空のときは空配列を返す', () => {
    const cache = new PostedUrlCache(CACHE_FILE);
    const batch = buildSlotBatch('slot07', [], [], cache);
    expect(batch).toHaveLength(0);
  });

  test('recentPostedTitles に同トピック記事があるとクロススロットで除外される', () => {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: 1, entries: [] }));
    const cache = new PostedUrlCache(CACHE_FILE);

    // slot07 で Sol/Terra/Luna 記事を投稿済みとしてシミュレート
    const recentPostedTitles = [
      'Sol/Terra/Luna tiered AI platform announced by Anthropic competitor',
    ];

    // slot11 に同トピックの別 URL 記事が流れてくる
    const rssItems = [
      makeRssItem({
        title: 'Sol/Terra/Luna pricing model enables small business AI adoption',
        url: 'https://example.com/sol-terra-luna-2',
      }),
      makeRssItem({
        title: 'OpenAI releases GPT-5 with advanced reasoning capabilities for enterprise',
        url: 'https://example.com/gpt5-unrelated',
      }),
    ];

    const batch = buildSlotBatch('slot11', rssItems, [], cache, 4, undefined, recentPostedTitles);

    // Sol/Terra/Luna 記事（2トークン以上共有: sol, terra, luna）は除外
    const solItem = batch.find(b => b.url === 'https://example.com/sol-terra-luna-2');
    expect(solItem).toBeUndefined();

    // 無関係の GPT-5 記事は除外されない
    const gpt5Item = batch.find(b => b.url === 'https://example.com/gpt5-unrelated');
    expect(gpt5Item).toBeDefined();
  });

  test('各バッチアイテムは必須フィールドを持つ', () => {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: 1, entries: [] }));
    const cache = new PostedUrlCache(CACHE_FILE);
    const rssItems = [makeRssItem()];

    const batch = buildSlotBatch('slot17', rssItems, [], cache);
    for (const item of batch) {
      expect(item.title).toBeTruthy();
      expect(item.url).toBeTruthy();
      expect(item.category).toBeTruthy();
      expect(item.hashtags).toBeTruthy();
    }
  });
});
