/**
 * affiliate-composer のユニットテスト
 *
 * Instagram キャプション / note 記事の純粋関数を検証する。
 * Playwright / Anthropic に依存しないためモック不要。
 */
import {
  composeInstagramAffiliateCaption,
  composeNoteAffiliateArticle,
} from '../src/utils/affiliate-composer';
import type { RankedProduct } from '../src/utils/affiliate-products';

// テスト用製品データ（3件）
const PRODUCTS: RankedProduct[] = [
  {
    id: 'macbook-air-m4',
    name: 'Apple MacBook Air M4（中古美品）',
    category: 'PC/Mac',
    affiliateUrl: 'https://hb.afl.rakuten.co.jp/ichiba/macbook',
    price: 146980,
    rating: 4.8,
    reviewCount: 1850,
    salesRank: 1,
    trendScore: 9.5,
    highlight: 'M4チップで生成AI処理が爆速',
    tags: ['MacBook', 'AI'],
    score: 9.1,
    rank: 1,
  },
  {
    id: 'anker-prime-160w',
    name: 'Anker Prime Charger (160W)',
    category: '充電器',
    affiliateUrl: 'https://hb.afl.rakuten.co.jp/ichiba/anker',
    price: 16990,
    rating: 4.6,
    reviewCount: 1500,
    salesRank: 1,
    trendScore: 7.0,
    highlight: 'MacBook・iPad・スマホを1台で高速充電',
    tags: ['充電器', 'Anker'],
    score: 7.02,
    rank: 2,
  },
  {
    id: 'plaud-notepin-s',
    name: 'PLAUD NotePin S（AIボイスレコーダー）',
    category: 'AIガジェット',
    affiliateUrl: 'https://hb.afl.rakuten.co.jp/ichiba/plaud',
    price: 28600,
    rating: 4.3,
    reviewCount: 200,
    salesRank: 1,
    trendScore: 10.0,
    highlight: '録音→自動文字起こし→AI要約',
    tags: ['AI', '文字起こし'],
    score: 5.99,
    rank: 3,
    pinned: true,
  },
];

const RANKING_TITLE = 'AIガジェット 今週の売れ筋ランキング TOP3';

// ─────────────────────────────────────────────────────────────────
// Instagram キャプション
// ─────────────────────────────────────────────────────────────────
describe('composeInstagramAffiliateCaption', () => {
  test('ランキングタイトルを含む', () => {
    const caption = composeInstagramAffiliateCaption(PRODUCTS, RANKING_TITLE);
    expect(caption).toContain(RANKING_TITLE);
  });

  test('全製品名を含む', () => {
    const caption = composeInstagramAffiliateCaption(PRODUCTS, RANKING_TITLE);
    for (const p of PRODUCTS) {
      expect(caption).toContain(p.name);
    }
  });

  test('全アフィリエイトURLを含む', () => {
    const caption = composeInstagramAffiliateCaption(PRODUCTS, RANKING_TITLE);
    for (const p of PRODUCTS) {
      expect(caption).toContain(p.affiliateUrl);
    }
  });

  test('ハッシュタグ #AIガジェット を含む', () => {
    const caption = composeInstagramAffiliateCaption(PRODUCTS, RANKING_TITLE);
    expect(caption).toContain('#AIガジェット');
  });

  test('2200文字以内に収まる', () => {
    const caption = composeInstagramAffiliateCaption(PRODUCTS, RANKING_TITLE);
    expect(caption.length).toBeLessThanOrEqual(2200);
  });

  test('maxLength を超えるときはハッシュタグを保持してトリム', () => {
    // maxLength を極端に小さくして強制トリムを確認
    const caption = composeInstagramAffiliateCaption(PRODUCTS, RANKING_TITLE, { maxLength: 300 });
    expect(caption.length).toBeLessThanOrEqual(300);
    expect(caption).toContain('#AIガジェット');
  });

  test('価格なし製品でもクラッシュしない', () => {
    const noPriceProduct: RankedProduct = {
      ...PRODUCTS[0],
      price: undefined,
      rank: 1,
    };
    expect(() => composeInstagramAffiliateCaption([noPriceProduct], RANKING_TITLE)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// note 記事
// ─────────────────────────────────────────────────────────────────
describe('composeNoteAffiliateArticle', () => {
  test('タイトルに年月版を含む', () => {
    const { title } = composeNoteAffiliateArticle(PRODUCTS, RANKING_TITLE, {
      updatedAt: '2026-06-22',
    });
    expect(title).toContain('2026年6月版');
  });

  test('タイトルにランキングタイトルを含む', () => {
    const { title } = composeNoteAffiliateArticle(PRODUCTS, RANKING_TITLE);
    expect(title).toContain(RANKING_TITLE);
  });

  test('本文に全製品名を含む', () => {
    const { body } = composeNoteAffiliateArticle(PRODUCTS, RANKING_TITLE);
    for (const p of PRODUCTS) {
      expect(body).toContain(p.name);
    }
  });

  test('本文に全アフィリエイトURLを含む（クリック可能リンク）', () => {
    const { body } = composeNoteAffiliateArticle(PRODUCTS, RANKING_TITLE);
    for (const p of PRODUCTS) {
      expect(body).toContain(p.affiliateUrl);
    }
  });

  test('本文にハッシュタグ #楽天 を含む', () => {
    const { body } = composeNoteAffiliateArticle(PRODUCTS, RANKING_TITLE);
    expect(body).toContain('#楽天');
  });

  test('price なし製品でもクラッシュしない', () => {
    const noPriceProduct: RankedProduct = {
      ...PRODUCTS[0],
      price: undefined,
      rank: 1,
    };
    expect(() => composeNoteAffiliateArticle([noPriceProduct], RANKING_TITLE)).not.toThrow();
  });

  test('updatedAt 省略時も正常動作', () => {
    const { title, body } = composeNoteAffiliateArticle(PRODUCTS, RANKING_TITLE);
    expect(title).toMatch(/\d{4}年\d{1,2}月版/);
    expect(body.length).toBeGreaterThan(0);
  });
});
