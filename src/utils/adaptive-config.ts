/**
 * アダプティブスケール設定
 *
 * KPI 目標に届かない場合に投稿量を段階的に引き上げるための共有設定。
 * adaptive-scaler.ts が毎日更新し、各投稿スクリプトがここを参照する。
 */
import fs from 'fs';
import path from 'path';

const CONFIG_FILE = path.join(process.cwd(), 'data', 'adaptive-config.json');

// ── スケールレベルの定義 ─────────────────────────────────────────────
// 投稿量が少なすぎると X アルゴリズムに「非活性アカウント」と判定されるリスクがある。
// 逆に多すぎると spam 判定のリスクがある。4 段階で漸進的に引き上げる。

export interface AdaptiveLevel {
  maxQuotesPerRun: number;  // 引用Bot 1 回あたりの最大引用数
  batchSizePerSlot: number; // ニュース記事投稿数 / スロット
  opinionPerDay: number;    // 意見ツイート投稿数 / 日
  noteCtaDaysOfWeek: number[]; // note 誘導ツイートを投稿する曜日 (0=日, 1=月 ... 6=土)
}

export const SCALE_LEVELS: Record<1 | 2 | 3 | 4, AdaptiveLevel> = {
  1: {
    maxQuotesPerRun: 1,
    batchSizePerSlot: 2,
    opinionPerDay: 1,
    noteCtaDaysOfWeek: [3, 5], // 水・金
  },
  2: {
    maxQuotesPerRun: 2,
    batchSizePerSlot: 3,
    opinionPerDay: 2,
    noteCtaDaysOfWeek: [1, 3, 5], // 月・水・金
  },
  3: {
    maxQuotesPerRun: 3,
    batchSizePerSlot: 4,
    opinionPerDay: 2,
    noteCtaDaysOfWeek: [1, 3, 4, 5], // 月・水・木・金
  },
  4: {
    maxQuotesPerRun: 3,
    batchSizePerSlot: 5,
    opinionPerDay: 3,
    noteCtaDaysOfWeek: [1, 2, 3, 4, 5], // 月〜金
  },
};

export interface AdaptiveConfig {
  updatedAt: string;
  level: 1 | 2 | 3 | 4;
  params: AdaptiveLevel;
  /**
   * ツイート 1 件あたりの平均インプレッション目標（avgImpressions と比較）。
   * ※「1日の総imp」ではなく「1ツイートの平均imp」であることに注意。
   * 実績 ~40 imp/tweet を踏まえ 60 を近期目標とする（達成後に 80 → 100 と段階的に引き上げる）。
   */
  targetImpPerDay: number;
  consecutiveMiss: number;   // 目標未達が連続した日数
  consecutiveHit: number;    // 目標達成が連続した日数
  reason: string;
  history: Array<{
    date: string;
    level: number;
    avgImpPerDay: number;
    action: string;
  }>;
}

const DEFAULT_CONFIG: AdaptiveConfig = {
  updatedAt: new Date().toISOString(),
  level: 1,
  params: SCALE_LEVELS[1],
  // 1 ツイートあたりの平均インプレッション目標。
  // 実績ベースラインは ~40 imp/tweet（2026-06 時点）。
  // 近期目標 60 → 中期 80 → 長期 100 と段階的に引き上げる。
  targetImpPerDay: 60,
  consecutiveMiss: 0,
  consecutiveHit: 0,
  reason: 'initial',
  history: [],
};

// ── 読み書き ─────────────────────────────────────────────────────────

export function loadAdaptiveConfig(): AdaptiveConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as AdaptiveConfig;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export function saveAdaptiveConfig(config: AdaptiveConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/** 現在のレベルに対応するパラメーターを返す */
export function getAdaptiveParams(): AdaptiveLevel {
  const config = loadAdaptiveConfig();
  return SCALE_LEVELS[config.level] ?? SCALE_LEVELS[1];
}

/** 今日（JST）が note CTA を投稿すべき曜日かどうかを判定 */
export function shouldPostNoteCta(): boolean {
  const params = getAdaptiveParams();
  // 環境変数で強制指定されている場合は常に true
  if (process.env['FORCE_NOTE_CTA'] === 'true') return true;
  const jstDay = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCDay();
  return params.noteCtaDaysOfWeek.includes(jstDay);
}
