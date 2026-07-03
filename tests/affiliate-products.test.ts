/**
 * affiliate-products のユニットテスト
 *
 * 重点: プレースホルダ/不正な affiliateUrl を持つ製品が
 *       ランキングに混入しない（＝壊れたリンクが投稿されない）こと。
 */
import {
  isValidAffiliateUrl,
  rankProducts,
  type AffiliateProduct,
} from '../src/utils/affiliate-products';

function makeProduct(over: Partial<AffiliateProduct> = {}): AffiliateProduct {
  return {
    id: 'p',
    name: '製品',
    category: 'ガジェット',
    affiliateUrl: 'https://hb.afl.rakuten.co.jp/ichiba/xxxx',
    rating: 4.5,
    reviewCount: 1000,
    salesRank: 1,
    trendScore: 5,
    highlight: 'テスト',
    tags: ['AI'],
    ...over,
  };
}

describe('isValidAffiliateUrl', () => {
  test('実際の楽天/Amazonリンクは有効', () => {
    expect(isValidAffiliateUrl('https://hb.afl.rakuten.co.jp/ichiba/abc')).toBe(true);
    expect(isValidAffiliateUrl('https://amzn.to/3xYzAbc')).toBe(true);
    expect(isValidAffiliateUrl('https://www.amazon.co.jp/dp/B0XXXX?tag=mytag-22')).toBe(true);
  });

  test('プレースホルダ(YOUR_LINK)は無効', () => {
    expect(isValidAffiliateUrl('https://amzn.to/YOUR_LINK_2')).toBe(false);
    expect(isValidAffiliateUrl('https://example.com/YOUR_LINK')).toBe(false);
  });

  test('空・未定義・非httpは無効', () => {
    expect(isValidAffiliateUrl('')).toBe(false);
    expect(isValidAffiliateUrl(undefined as unknown as string)).toBe(false);
    expect(isValidAffiliateUrl('   ')).toBe(false);
    expect(isValidAffiliateUrl('javascript:alert(1)')).toBe(false);
    expect(isValidAffiliateUrl('ftp://example.com/x')).toBe(false);
  });
});

describe('rankProducts', () => {
  test('プレースホルダURLの製品はランキングから除外される', () => {
    const products: AffiliateProduct[] = [
      makeProduct({ id: 'real-1', name: '実リンク1', salesRank: 1, trendScore: 9 }),
      makeProduct({ id: 'ph', name: 'ダミー', affiliateUrl: 'https://amzn.to/YOUR_LINK_2', salesRank: 1, trendScore: 10 }),
      makeProduct({ id: 'real-2', name: '実リンク2', salesRank: 2, trendScore: 8 }),
    ];
    const ranked = rankProducts(products, 3);
    const ids = ranked.map(p => p.id);
    expect(ids).not.toContain('ph');
    expect(ids).toContain('real-1');
    expect(ids).toContain('real-2');
    expect(ranked.length).toBe(2);
  });

  test('disabled な製品は従来どおり除外される', () => {
    const products: AffiliateProduct[] = [
      makeProduct({ id: 'a' }),
      makeProduct({ id: 'b', disabled: true }),
    ];
    const ranked = rankProducts(products, 3);
    expect(ranked.map(p => p.id)).toEqual(['a']);
  });

  test('rank は 1-indexed で連番付与される', () => {
    const products: AffiliateProduct[] = [
      makeProduct({ id: 'a', trendScore: 9 }),
      makeProduct({ id: 'b', trendScore: 5, salesRank: 2 }),
    ];
    const ranked = rankProducts(products, 3);
    expect(ranked.map(p => p.rank)).toEqual([1, 2]);
  });

  test('pinned 製品はスコアが低くても topN に必ず含まれる', () => {
    const products: AffiliateProduct[] = [
      makeProduct({ id: 'a', trendScore: 9, salesRank: 1 }),       // 高スコア
      makeProduct({ id: 'b', trendScore: 8, salesRank: 1 }),       // 高スコア
      makeProduct({ id: 'c', trendScore: 0, salesRank: 5, pinned: true }), // 低スコアだが固定
    ];
    const ranked = rankProducts(products, 2);
    const ids = ranked.map(p => p.id);
    expect(ranked.length).toBe(2);
    expect(ids).toContain('c');     // 固定枠で必ず入る
    expect(ids).not.toContain('b'); // 押し出される
  });

  test('pinned 製品も最終表示はスコア降順で並ぶ', () => {
    const products: AffiliateProduct[] = [
      makeProduct({ id: 'a', trendScore: 9, salesRank: 1 }),       // 最高スコア
      makeProduct({ id: 'c', trendScore: 0, salesRank: 5, pinned: true }), // 低スコア固定
    ];
    const ranked = rankProducts(products, 2);
    expect(ranked.map(p => p.id)).toEqual(['a', 'c']); // スコア順、rank 1,2
    expect(ranked.map(p => p.rank)).toEqual([1, 2]);
  });

  test('pinned 製品が topN を超える場合はスコア上位の pinned を優先', () => {
    const products: AffiliateProduct[] = [
      makeProduct({ id: 'p1', trendScore: 9, salesRank: 1, pinned: true }),
      makeProduct({ id: 'p2', trendScore: 1, salesRank: 5, pinned: true }),
      makeProduct({ id: 'p3', trendScore: 5, salesRank: 2, pinned: true }),
    ];
    const ranked = rankProducts(products, 2);
    expect(ranked.length).toBe(2);
    expect(ranked.map(p => p.id)).toEqual(['p1', 'p3']); // 高スコア pinned 2件
  });

  test('disabled な pinned 製品は除外される（固定より無効が優先）', () => {
    const products: AffiliateProduct[] = [
      makeProduct({ id: 'a' }),
      makeProduct({ id: 'c', pinned: true, disabled: true }),
    ];
    const ranked = rankProducts(products, 3);
    expect(ranked.map(p => p.id)).toEqual(['a']);
  });
});
