/**
 * PDCA 戦略ストア
 *
 * data/strategy.json に戦略調整値を永続化する。
 * - strategy-analyzer が毎夜更新
 * - runSlot() が起動時に読み込み、pipeline に適用
 *
 * 調整できる軸:
 *   1. categoryWeights    — カテゴリ別ウェイト (1.0=デフォルト)
 *   2. slotThemeOverrides — スロット別テーマ上書き（ネタ構成変更）
 *   3. sourceBoosts/Suppresses — RSS ソース優先度
 *   4. KPI 目標値 (targets)
 */
import fs from 'fs';
import path from 'path';
import { SlotName, XCategory, SLOT_THEMES } from './x-category';

export const STRATEGY_FILE = path.join(process.cwd(), 'data', 'strategy.json');

// ----------------------------------------------------------------
// 型定義
// ----------------------------------------------------------------

export interface KpiTargets {
  /** 1日の最低投稿成功件数（5スロット×4件 = 最大20件中） */
  dailyPostsMin: number;
  /** エラー率上限 (0.0–1.0) */
  errorRateMax: number;
  /** スキップ率上限（意見フィルタ+キャッシュ）(0.0–1.0) */
  skipRateMax: number;
  /** 週あたり有効カテゴリ数の最低値（20カテゴリ中） */
  weeklyCategoriesMin: number;
  /** impressions/投稿 目標（X API 未連携 = 0 で無効化） */
  impressionsPerPostMin: number;
}

export interface ContentStrategy {
  /** PDCA サイクル回数（更新の度に +1） */
  version: number;
  updatedAt: string;

  /** Claude が生成した直近サイクルのインサイト */
  insights: string[];

  /**
   * カテゴリ別ウェイト倍率
   * > 1.0: このカテゴリを優先（候補範囲を広げる・スロット内で複数スロット使用可）
   * < 1.0: 抑制（最新記事しか使わない）
   * 0.0:   完全無効化（スロットから除外）
   */
  categoryWeights: Partial<Record<XCategory, number>>;

  /**
   * スロット別テーマ上書き
   * SLOT_THEMES のデフォルトから変更したい場合に指定。
   * 同一カテゴリを2枠入れることで「2件/日」化も可能。
   * 例: { slot12: ['paper', 'paper', 'data_stats', 'rag_search'] }
   */
  slotThemeOverrides: Partial<Record<SlotName, XCategory[]>>;

  /** 優先する RSS ソース名（先頭に来るよう fetchAllRssItems に反映） */
  sourceBoosts: string[];
  /** 抑制する RSS ソース名（最後尾に押し下げ） */
  sourceSuppresses: string[];

  /** KPI 目標値 */
  targets: KpiTargets;

  /**
   * KPI 達成フラグ
   * true になると pdca-controller が自動停止ループを抜ける
   */
  kpiAchieved: boolean;

  /** 直近 PDCA で特定された問題点サマリー */
  problemSummary?: string;
}

// ----------------------------------------------------------------
// デフォルト戦略
// ----------------------------------------------------------------

export const DEFAULT_STRATEGY: ContentStrategy = {
  version: 0,
  updatedAt: new Date().toISOString(),
  insights: [],
  categoryWeights: {},
  slotThemeOverrides: {},
  sourceBoosts: [],
  sourceSuppresses: [],
  kpiAchieved: false,
  targets: {
    dailyPostsMin: 15,      // 20件中 15件以上成功
    errorRateMax: 0.10,     // エラー率 10% 以下
    skipRateMax: 0.20,      // スキップ率 20% 以下
    weeklyCategoriesMin: 14, // 週 14 カテゴリ以上カバー
    impressionsPerPostMin: 0, // X API 未連携時は 0 で無効
  },
};

// ----------------------------------------------------------------
// I/O
// ----------------------------------------------------------------

export function loadStrategy(): ContentStrategy {
  if (!fs.existsSync(STRATEGY_FILE)) return { ...DEFAULT_STRATEGY };
  try {
    const raw = fs.readFileSync(STRATEGY_FILE, 'utf-8');
    // デフォルトとマージ（新フィールドへの後方互換）
    return { ...DEFAULT_STRATEGY, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STRATEGY };
  }
}

export function saveStrategy(strategy: ContentStrategy): void {
  const dir = path.dirname(STRATEGY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(strategy, null, 2), 'utf-8');
}

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------

/** スロットの実効テーマ一覧（上書きがあればそれを優先） */
export function getEffectiveThemes(slot: SlotName, strategy: ContentStrategy): XCategory[] {
  const override = strategy.slotThemeOverrides[slot];
  return override && override.length > 0
    ? override
    : [...SLOT_THEMES[slot]];
}

/** カテゴリウェイトを返す（未指定は 1.0） */
export function getCategoryWeight(cat: XCategory, strategy: ContentStrategy): number {
  return strategy.categoryWeights[cat] ?? 1.0;
}
