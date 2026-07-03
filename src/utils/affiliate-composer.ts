/**
 * アフィリエイトランキングのプラットフォーム別コンテンツ生成
 *
 * 各 SNS のフォーマット制約に合わせた純粋関数。
 * Playwright / Anthropic に依存しないため単体テスト可能。
 *
 * ─ プラットフォーム別制約 ─────────────────────────────────────────
 * Instagram  : キャプション最大 2,200 文字。リンクは非クリック（コピペ用テキスト）
 * note       : 本文は改行区切りのプレーンテキスト。クリック可能リンク → SEO 効果あり
 * ─────────────────────────────────────────────────────────────────
 */
import { RankedProduct, getRankEmoji, formatPrice } from './affiliate-products';

// ----------------------------------------------------------------
// Instagram キャプション
// ----------------------------------------------------------------

export interface InstagramAffiliateCaptionOpts {
  /** ランキング期間ラベル（既定: "今週"） */
  rankingPeriod?: string;
  /** キャプション最大文字数（既定: 2200）*/
  maxLength?: number;
}

/**
 * Instagram 用アフィリエイトランキングキャプションを生成する。
 *
 * - 楽天アフィリエイト URL はテキストとして埋め込む（Instagram 上は非クリック）
 * - ハッシュタグは末尾にまとめる（製品タグ + 固定タグ）
 * - 2,200 文字を超える場合は末尾をトリムしてハッシュタグのみ保持する
 */
export function composeInstagramAffiliateCaption(
  products: RankedProduct[],
  rankingTitle: string,
  opts: InstagramAffiliateCaptionOpts = {},
): string {
  const { rankingPeriod = '今週', maxLength = 2200 } = opts;

  const lines: string[] = [
    `🏆【${rankingTitle}】`,
    '',
    `毎週月曜更新｜${rankingPeriod}の売れ筋AIガジェットTOP${products.length}`,
    '',
  ];

  for (const p of products) {
    const priceStr = formatPrice(p.price);
    const ratingStr = `★${p.rating}（${p.reviewCount.toLocaleString('ja-JP')}件）`;

    lines.push(`${getRankEmoji(p.rank)}${p.rank}位: ${p.name}`);
    lines.push(p.highlight);
    if (priceStr) lines.push(`${priceStr}前後　${ratingStr}`);
    lines.push(`🛒 ${p.affiliateUrl}`);
    lines.push('');
  }

  const hashtags = buildInstagramHashtags(products);

  const body = lines.join('\n').trim();

  // 文字数チェック（超過時は本文末尾をトリムしてタグ保持）
  const full = `${body}\n\n${hashtags}`;
  if (full.length <= maxLength) return full;

  const budget = maxLength - hashtags.length - 2; // 2 = '\n\n'
  return `${body.slice(0, budget).trimEnd()}\n\n${hashtags}`;
}

function buildInstagramHashtags(products: RankedProduct[]): string {
  const tagSet = new Set<string>([
    '#AIガジェット',
    '#楽天',
    '#ランキング',
    '#おすすめ',
    '#ガジェット',
  ]);
  for (const p of products) {
    for (const t of p.tags.slice(0, 2)) {
      tagSet.add(`#${t.replace(/^#/, '')}`);
      if (tagSet.size >= 12) break;
    }
    if (tagSet.size >= 12) break;
  }
  return [...tagSet].join(' ');
}

// ----------------------------------------------------------------
// note 記事
// ----------------------------------------------------------------

export interface NoteAffiliateArticle {
  /** note 記事タイトル */
  title: string;
  /** note 本文（改行区切りプレーンテキスト） */
  body: string;
}

export interface NoteAffiliateArticleOpts {
  /** ランキング期間ラベル（既定: "今週"） */
  rankingPeriod?: string;
  /** データ更新日 YYYY-MM-DD（タイトルの年月に使用、既定: 実行日） */
  updatedAt?: string;
}

/**
 * note 用アフィリエイトランキング記事を生成する。
 *
 * - タイトル: 「【{year}年{month}月版】{rankingTitle}｜楽天おすすめ厳選」
 * - 本文: 製品ごとにセクションを分けてアフィリエイト URL を掲載（クリック可能）
 * - 末尾にハッシュタグを付ける
 */
export function composeNoteAffiliateArticle(
  products: RankedProduct[],
  rankingTitle: string,
  opts: NoteAffiliateArticleOpts = {},
): NoteAffiliateArticle {
  const { rankingPeriod = '今週', updatedAt } = opts;

  // タイトル用の年月
  const base = updatedAt ? new Date(updatedAt) : new Date();
  const year = base.getFullYear();
  const month = base.getMonth() + 1;
  const titleDate = `${year}年${month}月版`;

  const title = `【${titleDate}】${rankingTitle}｜楽天おすすめ厳選`;

  const bodyLines: string[] = [
    `毎週月曜日更新！${rankingTitle}をお届けします。`,
    `楽天で買えるAIガジェット・ツールを編集部が厳選しました。`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ];

  for (const p of products) {
    const priceStr = formatPrice(p.price);
    const ratingStr = `★${p.rating}（${p.reviewCount.toLocaleString('ja-JP')}件）`;

    bodyLines.push(`${getRankEmoji(p.rank)} ${p.rank}位: ${p.name}`);
    if (priceStr) {
      bodyLines.push(`価格: ${priceStr}前後　評価: ${ratingStr}`);
    } else {
      bodyLines.push(`評価: ${ratingStr}`);
    }
    bodyLines.push('');
    bodyLines.push(p.highlight);
    bodyLines.push('');
    bodyLines.push(`▶ 楽天で見る: ${p.affiliateUrl}`);
    bodyLines.push('');
    bodyLines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    bodyLines.push('');
  }

  bodyLines.push(`毎週月曜日に${rankingPeriod}のランキングを更新しています。来週もお楽しみに！`);
  bodyLines.push('');

  const hashtags = buildNoteHashtags(products);
  bodyLines.push(hashtags);

  return { title, body: bodyLines.join('\n').trim() };
}

function buildNoteHashtags(products: RankedProduct[]): string {
  const tagSet = new Set<string>([
    '#AIガジェット',
    '#楽天',
    '#ランキング',
    '#おすすめガジェット',
    '#AI',
  ]);
  for (const p of products) {
    for (const t of p.tags.slice(0, 2)) {
      tagSet.add(`#${t.replace(/^#/, '')}`);
      if (tagSet.size >= 10) break;
    }
    if (tagSet.size >= 10) break;
  }
  return [...tagSet].join(' ');
}
