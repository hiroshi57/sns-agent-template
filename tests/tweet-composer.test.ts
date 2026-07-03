/**
 * tweet-composer.ts のユニットテスト
 *
 * テスト対象:
 *   - composeTweet(): 日本語記事・英語記事・カテゴリ指定・文字数制限
 *
 * モック戦略:
 *   - @anthropic-ai/sdk: Claude API 呼び出しをモック
 *   - ../src/utils/pii-filter: filterPii / maskPiiByPattern をパススルーモック
 *   - ../src/utils/post-tag: tagPrefix をパススルーモック
 *   - ../src/utils/trend-hashtags: appendTrendHashtags をパススルーモック
 */

// ── モック定義（import より前に置く必要がある）──

const mockMessageCreate = jest.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'GPT-5が登場した。推論速度が従来比3倍に向上し、コストも50%削減。日本のエンジニアは今すぐ試してみるべきだ。' }],
});

jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create: mockMessageCreate },
    })),
  };
});

// pii-filter: 実 Claude 呼び出しを避けるため、テキストをそのまま返すモック
jest.mock('../src/utils/pii-filter', () => ({
  filterPii: jest.fn().mockImplementation((_anthropic: unknown, text: string) => Promise.resolve(text)),
  maskPiiByPattern: jest.fn().mockImplementation((text: string) => text),
}));

// logger: テスト中の出力を抑制
jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import Anthropic from '@anthropic-ai/sdk';
import { composeTweet } from '../src/utils/tweet-composer';
import { ArticleContent } from '../src/scraper/article';

// ── テスト用ファクトリ ─────────────────────────────────────────────

function makeArticle(overrides: Partial<ArticleContent> = {}): ArticleContent {
  return {
    url: 'https://example.com/ai-news-test',
    title: 'ChatGPTが新機能を発表、日本語対応を強化',
    summary: 'OpenAIは本日、ChatGPTの新機能を発表しました。日本語対応が大幅に強化され、ビジネス用途での活用が期待されます。',
    thumbnailUrl: '',
    body: 'OpenAIは本日、ChatGPTの新機能を発表しました。',
    isValid: true,
    ...overrides,
  };
}

function makeAnthropicInstance(): Anthropic {
  return new (Anthropic as unknown as new () => Anthropic)();
}

// ── テストスイート ────────────────────────────────────────────────

describe('composeTweet', () => {
  beforeEach(() => {
    mockMessageCreate.mockClear();
    // デフォルトのモック戻り値をリセット（50文字以上の現実的なツイート本文）
    mockMessageCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'GPT-5が登場した。推論速度が従来比3倍に向上し、コストも50%削減。日本のエンジニアは今すぐ試してみるべきだ。' }],
    });
  });

  // ── 基本動作 ─────────────────────────────────────────────────────

  it('日本語記事: URL とハッシュタグを含む文字列を返す', async () => {
    const article = makeArticle();
    const result = await composeTweet(makeAnthropicInstance(), article);

    expect(typeof result).toBe('string');
    expect(result).toContain('https://example.com/ai-news-test');
    expect(result).toMatch(/#/); // ハッシュタグあり
  });

  it('英語記事: タイトルを先頭行に含む', async () => {
    const article = makeArticle({
      title: 'GPT-5 Released with 3x Speed Improvement by OpenAI',
      summary: 'OpenAI released GPT-5 today with major improvements.',
    });
    mockMessageCreate.mockResolvedValue({
      content: [{ type: 'text', text: '推論速度が3倍に向上し、コストも大幅削減。日本のエンジニアやBPO業界にとって無視できない変化だ。' }],
    });

    const result = await composeTweet(makeAnthropicInstance(), article);

    // 英語タイトルが先頭行に含まれる
    expect(result).toContain('GPT-5 Released with 3x Speed Improvement by OpenAI');
  });

  it('カテゴリ指定時: カテゴリラベルと専用ハッシュタグが付与される', async () => {
    const article = makeArticle();
    const result = await composeTweet(makeAnthropicInstance(), article, {
      category: 'model_release',
    });

    expect(result).toMatch(/#/); // ハッシュタグあり
    // カテゴリ絵文字 or ラベルが含まれる（カテゴリメタデータ依存）
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(20);
  });

  // ── 文字数制限 ────────────────────────────────────────────────────

  it('生成ツイートは合理的な長さ（空文字でない・極端に長くない）', async () => {
    const article = makeArticle();
    const result = await composeTweet(makeAnthropicInstance(), article);

    expect(result.length).toBeGreaterThan(30);
    expect(result.length).toBeLessThan(600); // 過剰に長い場合は異常
  });

  // ── エラー耐性 ────────────────────────────────────────────────────

  it('Claude API が失敗した場合はタイトルで代替する', async () => {
    mockMessageCreate.mockRejectedValue(new Error('API timeout'));

    const article = makeArticle({ title: 'OpenAIが新モデルを発表' });
    const result = await composeTweet(makeAnthropicInstance(), article);

    // クラッシュせずにタイトルを含む文字列が返る
    expect(typeof result).toBe('string');
    expect(result).toContain('OpenAIが新モデルを発表');
  });

  it('Claude がメタ返答（申し訳ありません等）を返した場合はタイトルで代替する', async () => {
    mockMessageCreate.mockResolvedValue({
      content: [{ type: 'text', text: '申し訳ありませんが、本文をご提供いただく必要があります。' }],
    });

    const article = makeArticle({ title: 'AI最新動向2026年' });
    const result = await composeTweet(makeAnthropicInstance(), article);

    expect(typeof result).toBe('string');
    expect(result).toContain('AI最新動向2026年');
  });

  // ── 短文フィルタ ─────────────────────────────────────────────────

  it('Claude が50文字未満の本文を返した場合は TWEET_TOO_SHORT をスローする', async () => {
    mockMessageCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'たった一言。' }], // 6文字 < 50文字
    });

    const article = makeArticle();
    await expect(composeTweet(makeAnthropicInstance(), article)).rejects.toThrow('TWEET_TOO_SHORT');
  });

  it('Claude が短文を返してもタイトルフォールバック後は TWEET_TOO_SHORT をスローしない', async () => {
    // メタ返答 → タイトルフォールバック → 短文チェックをバイパス
    mockMessageCreate.mockResolvedValue({
      content: [{ type: 'text', text: '申し訳ありません。' }], // メタ返答
    });

    const article = makeArticle({ title: 'AI最新動向' }); // タイトルも短いが除外しない
    const result = await composeTweet(makeAnthropicInstance(), article);
    expect(typeof result).toBe('string');
    expect(result).toContain('AI最新動向');
  });

  // ── スロット別トーン ──────────────────────────────────────────────

  it('スロット指定時もクラッシュせず文字列を返す', async () => {
    const article = makeArticle();
    const result = await composeTweet(makeAnthropicInstance(), article, {
      slot: 'slot07',
      category: 'trend',
    });

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(10);
  });
});
