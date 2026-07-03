/**
 * X（Twitter）の重み付き文字数カウントと、上限内に収める投稿文ビルダー。
 *
 * X の仕様（twitter-text 準拠の近似）:
 *  - URL は t.co により一律 23 文字換算
 *  - 日本語(かな/漢字)・全角・CJK記号・絵文字は 2 文字換算
 *  - それ以外（半角英数記号）は 1 文字
 *
 * 標準アカウントの上限は 280 weighted。
 */

const TWEET_LIMIT = 280;
const URL_WEIGHT = 23;
const URL_REGEX = /https?:\/\/[^\s]+/g;

/** コードポイントが 2 文字換算（CJK/全角/絵文字）か判定 */
function isWide(codePoint: number): boolean {
  // 絵文字など астral 面（サロゲートペア）はおおむね 2 換算
  if (codePoint > 0xffff) return true;
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0x303f) || // CJK部首・記号
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // ひらがな・カタカナ
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK拡張A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK統合漢字
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK互換漢字
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK互換形
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角英数・記号
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)    // 全角通貨記号など
  );
}

/** X 換算の重み付き文字数を返す */
export function weightedTweetLength(text: string): number {
  if (!text) return 0;

  // URL を 23 文字換算するため、一旦取り除いて URL 数を数える
  const urls = text.match(URL_REGEX) ?? [];
  const withoutUrls = text.replace(URL_REGEX, '');

  let weight = urls.length * URL_WEIGHT;
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0;
    weight += isWide(cp) ? 2 : 1;
  }
  return weight;
}

/** limit（既定 280）以内に収まるか */
export function fitsTweet(text: string, limit: number = TWEET_LIMIT): boolean {
  return weightedTweetLength(text) <= limit;
}

export interface RankingLineItem {
  rank: number;
  name: string;
  url: string;
  emoji?: string;
}

/**
 * ランキング投稿文を「必ず limit 以内」に収めて生成する。
 *
 * 方針:
 *  - タイトル + 各行「emoji 製品名 \n 👉 URL」。フック文は付けない（長さ節約）。
 *  - 全URLは本文に残す（収益リンクを落とさない）。
 *  - ハッシュタグ付きで超過する場合はハッシュタグを落とす。
 *  - それでも超過する場合は製品名を末尾から切り詰める（…）。
 */
export function buildCompactRankingTweet(
  title: string,
  items: RankingLineItem[],
  opts: { limit?: number; hashtags?: string } = {},
): string {
  const limit = opts.limit ?? TWEET_LIMIT;

  const compose = (names: string[], withHashtags: boolean): string => {
    const lines: string[] = [`🏆【${title}】`];
    items.forEach((it, i) => {
      const emoji = it.emoji ?? `${it.rank}位`;
      lines.push(`${emoji} ${names[i]}`);
      lines.push(`👉 ${it.url}`);
    });
    if (withHashtags && opts.hashtags) lines.push(opts.hashtags);
    return lines.join('\n');
  };

  let names = items.map(it => it.name);

  // 1) ハッシュタグありで試す
  let tweet = compose(names, true);
  if (fitsTweet(tweet, limit)) return tweet;

  // 2) ハッシュタグを落とす
  tweet = compose(names, false);
  if (fitsTweet(tweet, limit)) return tweet;

  // 3) まだ超過 → 製品名を一律に切り詰める（最長から削る）
  for (let maxNameLen = 30; maxNameLen >= 6; maxNameLen -= 2) {
    names = items.map(it =>
      it.name.length > maxNameLen ? it.name.slice(0, maxNameLen - 1) + '…' : it.name,
    );
    tweet = compose(names, false);
    if (fitsTweet(tweet, limit)) return tweet;
  }

  // 最終手段（理論上ここには来ない想定）
  return tweet;
}
