/**
 * アフィリエイト製品カタログ管理 + ランキング計算
 *
 * data/affiliate-products.json を読み込み、スコアリングして
 * 上位 N 件を返す。スコアは以下で計算:
 *
 *   baseScore = rating × log10(reviewCount + 10) × (1 / salesRank)
 *   finalScore = baseScore × (1 + trendScore × 0.2)
 *
 * - rating      : Amazonなどの評価 (1〜5)
 * - reviewCount : レビュー件数（多いほど信頼度UP）
 * - salesRank   : 売上ランク（1が最高位）
 * - trendScore  : 0〜10のトレンド度（手動設定、高いほど今話題）
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

// ----------------------------------------------------------------
// 型定義
// ----------------------------------------------------------------

export interface AffiliateProduct {
  /** 一意ID（URLスラグ形式: macbook-air-m4） */
  id: string;
  /** 製品名（投稿に表示） */
  name: string;
  /** カテゴリ（PC/Mac | スマートスピーカー | タブレット | ガジェット | カメラ | ヘッドフォン | その他） */
  category: string;
  /** アフィリエイトURL（Amazon アソシエイト / 楽天など） */
  affiliateUrl: string;
  /** 製品画像URL（省略可） */
  imageUrl?: string;
  /** 税込価格（円）省略可 */
  price?: number;
  /** 評価スコア（1〜5、小数可） */
  rating: number;
  /** レビュー件数 */
  reviewCount: number;
  /** 売上ランク（カテゴリ内、1が最高位） */
  salesRank: number;
  /** トレンドスコア（0〜10、手動設定・今週の話題度） */
  trendScore: number;
  /** 発売年（省略可） */
  releaseYear?: number;
  /** 一言アピール（Claudeへのヒントにも使用） */
  highlight: string;
  /** タグ（ハッシュタグ生成に使用） */
  tags: string[];
  /** 無効フラグ（true ならランキングから除外） */
  disabled?: boolean;
  /** 固定フラグ（true ならスコアに関わらず必ず topN に含まれる） */
  pinned?: boolean;
}

export interface AffiliateProductsData {
  /** データ最終更新日 (YYYY-MM-DD) */
  updatedAt: string;
  /** ランキング期間ラベル（"今週" / "今月" など） */
  rankingPeriod: string;
  /** ランキングタイトル（省略時は自動生成） */
  rankingTitle?: string;
  /** 製品リスト */
  products: AffiliateProduct[];
}

export interface RankedProduct extends AffiliateProduct {
  /** 計算済みランキングスコア */
  score: number;
  /** 順位（1-indexed） */
  rank: number;
}

// ----------------------------------------------------------------
// データ読み込み
// ----------------------------------------------------------------

const DATA_FILE = path.join(process.cwd(), 'data', 'affiliate-products.json');

export function loadAffiliateProducts(): AffiliateProductsData | null {
  if (!fs.existsSync(DATA_FILE)) {
    logger.warn(`[Affiliate] ${DATA_FILE} が見つかりません。アフィリエイトランキング投稿をスキップします。`);
    return null;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data: AffiliateProductsData = JSON.parse(raw);
    if (!Array.isArray(data.products) || data.products.length === 0) {
      logger.warn('[Affiliate] 製品データが空です。');
      return null;
    }
    logger.info(`[Affiliate] 製品データ読み込み: ${data.products.length} 件 (${data.updatedAt})`);
    return data;
  } catch (err) {
    logger.error(`[Affiliate] データ読み込みエラー: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ----------------------------------------------------------------
// ランキング計算
// ----------------------------------------------------------------

/**
 * 製品リストをスコアリングして上位 topN 件を返す
 *
 * スコア計算:
 *   baseScore   = rating × log10(reviewCount + 10) / salesRank
 *   finalScore  = baseScore × (1 + trendScore × 0.2)
 */
export function rankProducts(products: AffiliateProduct[], topN = 3): RankedProduct[] {
  const active = products.filter(p => !p.disabled && isValidAffiliateUrl(p.affiliateUrl));

  const scored = active.map(p => {
    const base = (p.rating / 5) * Math.log10(p.reviewCount + 10) * (1 / Math.max(p.salesRank, 1));
    const score = base * (1 + Math.min(p.trendScore, 10) * 0.2);
    return { ...p, score };
  });

  // pinned 製品は必ず topN に含める（スコア上位の pinned を優先）
  const pinned   = scored.filter(p => p.pinned).sort((a, b) => b.score - a.score).slice(0, topN);
  const pinnedIds = new Set(pinned.map(p => p.id));
  const rest     = scored.filter(p => !pinnedIds.has(p.id)).sort((a, b) => b.score - a.score);

  const combined = [...pinned, ...rest].slice(0, topN);

  // 最終表示はスコア降順
  combined.sort((a, b) => b.score - a.score);

  return combined.map((p, i) => ({ ...p, rank: i + 1 }));
}

// ----------------------------------------------------------------
// ランク別絵文字
// ----------------------------------------------------------------

export const RANK_EMOJI: Record<number, string> = {
  1: '🥇',
  2: '🥈',
  3: '🥉',
};

export function getRankEmoji(rank: number): string {
  return RANK_EMOJI[rank] ?? `${rank}位`;
}

// ----------------------------------------------------------------
// 価格フォーマット
// ----------------------------------------------------------------

export function formatPrice(price?: number): string {
  if (!price) return '';
  return `¥${price.toLocaleString('ja-JP')}`;
}

// ----------------------------------------------------------------
// URL バリデーション
// ----------------------------------------------------------------

/** プレースホルダー文字列パターン（無効URLの検出に使用） */
const PLACEHOLDER_PATTERNS = [/YOUR_LINK/i, /PLACEHOLDER/i, /SAMPLE/i, /EXAMPLE/i];

/** 有効なアフィリエイト URL かどうかを判定する */
export function isValidAffiliateUrl(url: string): boolean {
  if (!url || typeof url !== 'string' || !url.trim()) return false;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  if (PLACEHOLDER_PATTERNS.some(p => p.test(url))) return false;
  return true;
}
