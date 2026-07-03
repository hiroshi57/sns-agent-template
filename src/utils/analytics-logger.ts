/**
 * X 投稿分析ログ (data/x-analytics.jsonl)
 *
 * JSONL 形式（1行 1 JSON）で追記。
 * 週次レポート生成・ソース別パフォーマンス分析に使用。
 */
import fs from 'fs';
import path from 'path';
import { XCategory } from './x-category';
import { SlotName } from './x-category';
import { logger } from './logger';

const LOG_FILE = path.join(process.cwd(), 'data', 'x-analytics.jsonl');
const SLOT_SUMMARY_FILE = path.join(process.cwd(), 'data', 'x-slot-summary.jsonl');

export type Platform = 'x' | 'instagram' | 'threads' | 'tiktok' | 'note';

/**
 * x-slot-summary.jsonl の1レコード形式
 */
export interface SlotRunSummary {
  type: 'slot_summary';
  date: string;             // 'YYYY-MM-DD'
  executedAt: string;       // ISO 8601
  slot: SlotName;
  totalMessages: number;
  opinionSkipped: number;
  cacheSkipped: number;
  qualityCandidates: number;
  batchSize: number;
  succeeded: number;
  errored: number;
  categoriesUsed: XCategory[];
  dryRun: boolean;
}

export interface AnalyticsRecord {
  postedAt: string;       // ISO 8601
  /** note 日次バッチは 'note_daily'、note 週次バッチは 'note_weekly'（後方互換）、気休めネタは 'relief'、アフィリエイトランキングは 'affiliate'、それ以外は SlotName */
  slot: SlotName | 'note_daily' | 'note_weekly' | 'relief' | 'affiliate';
  /** 投稿先プラットフォーム（省略時は 'x' として扱う） */
  platform?: Platform;
  theme: XCategory | 'affiliate_ranking';
  source: string;         // 'techcrunch' | 'verge' | 'chatwork' | 'weekly_batch' etc.
  url: string;
  title: string;
  imageAttached: boolean;
  success: boolean;
  /** 投稿テキストの文字数 */
  contentLength?: number;
  /** @deprecated tweetLength は contentLength に統合。既存ログ互換のため残す */
  tweetLength?: number;
}

/**
 * x-analytics.jsonl を読み込んで直近 windowDays 日分の AnalyticsRecord を返す。
 */
export function readAnalyticsRecords(windowDays = 7): AnalyticsRecord[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
  return lines
    .map((line) => {
      try { return JSON.parse(line) as AnalyticsRecord; }
      catch { return null; }
    })
    .filter((r): r is AnalyticsRecord => r !== null)
    .filter((r) => new Date(r.postedAt).getTime() > cutoff);
}

/**
 * x-slot-summary.jsonl を読み込んで直近 windowDays 日分の SlotRunSummary を返す。
 */
export function readSlotSummaries(windowDays = 7): SlotRunSummary[] {
  if (!fs.existsSync(SLOT_SUMMARY_FILE)) return [];
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const lines = fs.readFileSync(SLOT_SUMMARY_FILE, 'utf-8').split('\n').filter(Boolean);
  return lines
    .map((line) => {
      try { return JSON.parse(line) as SlotRunSummary; }
      catch { return null; }
    })
    .filter((r): r is SlotRunSummary => r !== null)
    .filter((r) => new Date(r.executedAt).getTime() > cutoff);
}

/**
 * 投稿結果を x-analytics.jsonl に追記する。
 * 書き込み失敗は warn のみ（投稿処理には影響しない）。
 */
export function logAnalytics(record: AnalyticsRecord): void {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    logger.warn(
      `Analytics ログ書き込み失敗: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * x-slot-summary.jsonl に SlotRunSummary を追記する。
 * PDCA の collectKpis() がこのファイルを読む。
 */
export function logSlotSummary(summary: SlotRunSummary): void {
  try {
    const dir = path.dirname(SLOT_SUMMARY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(SLOT_SUMMARY_FILE, JSON.stringify(summary) + '\n', 'utf-8');
  } catch (err) {
    logger.warn(
      `SlotSummary ログ書き込み失敗: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * x-analytics.jsonl を読み込んで週次サマリーをコンソール出力する。
 * `npm run x:report` 等から呼び出す想定。
 */
export function printWeeklySummary(): void {
  if (!fs.existsSync(LOG_FILE)) {
    console.log('まだ投稿ログがありません。');
    return;
  }

  const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
  const records: AnalyticsRecord[] = lines
    .map((line) => {
      try { return JSON.parse(line) as AnalyticsRecord; }
      catch { return null; }
    })
    .filter((r): r is AnalyticsRecord => r !== null);

  // 直近7日間に絞る
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const week = records.filter(
    (r) => new Date(r.postedAt).getTime() > cutoff
  );

  if (week.length === 0) {
    console.log('直近7日間の投稿ログがありません。');
    return;
  }

  const success = week.filter((r) => r.success);
  const failed  = week.filter((r) => !r.success);

  // テーマ別集計
  const byTheme = new Map<string, number>();
  for (const r of success) {
    byTheme.set(r.theme, (byTheme.get(r.theme) ?? 0) + 1);
  }
  const themeRanking = [...byTheme.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // ソース別集計
  const bySource = new Map<string, number>();
  for (const r of success) {
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
  }
  const sourceRanking = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1]);

  // スロット別集計（note 系は除外）
  const bySlot = new Map<string, number>();
  for (const r of success) {
    if (r.slot !== 'note_weekly' && r.slot !== 'note_daily') {
      bySlot.set(r.slot, (bySlot.get(r.slot) ?? 0) + 1);
    }
  }

  // プラットフォーム別集計
  const byPlatform = new Map<string, number>();
  for (const r of success) {
    const p = r.platform ?? 'x';
    byPlatform.set(p, (byPlatform.get(p) ?? 0) + 1);
  }

  const now = new Date();
  console.log('');
  console.log(`=== 週次レポート ${now.toLocaleDateString('ja-JP')} ===`);
  console.log(`総試行: ${week.length} 件  成功: ${success.length} 件  失敗: ${failed.length} 件`);
  console.log(`画像添付率: ${Math.round((success.filter(r => r.imageAttached).length / (success.length || 1)) * 100)}%`);
  console.log('');
  console.log('【プラットフォーム別】');
  for (const [p, n] of [...byPlatform.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${p}: ${n} 件`);
  console.log('');
  console.log('【テーマ別 TOP5】');
  themeRanking.forEach(([t, n], i) => console.log(`  ${i + 1}. ${t}: ${n} 件`));
  console.log('');
  console.log('【ソース別】');
  sourceRanking.forEach(([s, n]) => console.log(`  ${s}: ${n} 件`));
  console.log('');
  console.log('【スロット別（X.com のみ）】');
  for (const [sl, n] of bySlot) console.log(`  ${sl}: ${n} 件`);
  console.log('');
}
