/**
 * tweet-length のユニットテスト
 *
 * X の文字数カウント仕様に合わせる:
 *  - URL は t.co 短縮で一律 23 文字換算
 *  - 日本語(CJK)・全角・絵文字は 2 文字換算
 *  - それ以外(半角英数記号)は 1 文字
 * 280 weighted を超えないツイートを保証する。
 */
import {
  weightedTweetLength,
  fitsTweet,
  buildCompactRankingTweet,
} from '../src/utils/tweet-length';

const RAKUTEN_URL =
  'https://hb.afl.rakuten.co.jp/ichiba/54e8bbf1.57a12378.54e8bbf2.fba387f1/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fwhatfun-pc%2Fair-mw123-a%2F';

describe('weightedTweetLength', () => {
  test('半角英数は1文字換算', () => {
    expect(weightedTweetLength('abcde 12345')).toBe(11);
  });

  test('日本語は2文字換算', () => {
    expect(weightedTweetLength('あいう')).toBe(6);
    expect(weightedTweetLength('東京')).toBe(4);
  });

  test('URLは長さに関わらず23文字換算', () => {
    expect(weightedTweetLength(RAKUTEN_URL)).toBe(23);
    expect(weightedTweetLength(`A ${RAKUTEN_URL}`)).toBe(2 + 23); // "A " = 2
  });

  test('複数URL + 日本語の混在', () => {
    // "見て " (見=2,て=2,空白=1 =5) + URL(23) + URL(23)
    const t = `見て ${RAKUTEN_URL} ${RAKUTEN_URL}`;
    expect(weightedTweetLength(t)).toBe(5 + 23 + 1 + 23);
  });
});

describe('fitsTweet', () => {
  test('280以内は true、超過は false', () => {
    expect(fitsTweet('a'.repeat(280))).toBe(true);
    expect(fitsTweet('a'.repeat(281))).toBe(false);
    expect(fitsTweet('あ'.repeat(140))).toBe(true);  // 280
    expect(fitsTweet('あ'.repeat(141))).toBe(false); // 282
  });
});

describe('buildCompactRankingTweet', () => {
  const items = [
    { rank: 1, emoji: '🥇', name: 'Apple MacBook Air M4（中古美品）', url: RAKUTEN_URL },
    { rank: 2, emoji: '🥈', name: 'Anker Prime Charger (160W, 3 Ports)', url: RAKUTEN_URL },
    { rank: 3, emoji: '🥉', name: 'PLAUD NotePin S（AIボイスレコーダー）', url: RAKUTEN_URL },
  ];

  test('実データ3商品+長い楽天URLでも280以内に収まる', () => {
    const tweet = buildCompactRankingTweet('AIガジェット 今週の売れ筋ランキング TOP3', items);
    expect(weightedTweetLength(tweet)).toBeLessThanOrEqual(280);
  });

  test('全URLが本文に含まれる（収益リンクを落とさない）', () => {
    const tweet = buildCompactRankingTweet('AIガジェット 今週の売れ筋ランキング TOP3', items);
    const urlCount = (tweet.match(/https?:\/\//g) || []).length;
    expect(urlCount).toBe(3);
  });

  test('ハッシュタグ付きでも280を超えない（超える場合はタグを落とす）', () => {
    const tweet = buildCompactRankingTweet('AIガジェット 今週の売れ筋ランキング TOP3', items, {
      hashtags: '#AI #ガジェット #生産性 #テレワーク #おすすめ',
    });
    expect(weightedTweetLength(tweet)).toBeLessThanOrEqual(280);
  });
});
