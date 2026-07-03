/**
 * スロット別投稿効率分析 (#54)
 *
 * x-slot-summary.jsonl からスロットごとの成功率・効率・候補数を集計し
 * パフォーマンスレポートを出力する。
 *
 * インプレッション別データは X API 連携後に追加予定。
 * 現時点では「成功率」「効率（候補→成功変換率）」「スキップ率」で評価する。
 *
 * 使い方:
 *   npm run pdca:slot-analysis
 *   npm run pdca:slot-analysis -- --days=14
 *   npm run pdca:slot-analysis -- --json
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { logger } from './utils/logger';

const SLOT_SUMMARY_FILE = path.join(process.cwd(), 'data', 'x-slot-summary.jsonl');
const OUTPUT_FILE       = path.join(process.cwd(), 'data', 'slot-performance.json');

// ----------------------------------------------------------------
// 型定義
// ----------------------------------------------------------------

interface SlotSummaryRecord {
  type: 'slot_summary';
  date: string;
  executedAt: string;
  slot: string;
  totalMessages: number;
  opinionSkipped: number;
  cacheSkipped: number;
  qualityCandidates: number;
  batchSize: number;
  succeeded: number;
  errored: number;
  categoriesUsed: string[];
  dryRun: boolean;
}

export interface SlotStats {
  slot: string;
  runs: number;
  totalSucceeded: number;
  totalErrored: number;
  totalSkipped: number;
  totalMessages: number;
  totalCandidates: number;
  /** 成功率 = succeeded / (succeeded + errored) */
  successRate: number;
  /** 効率 = succeeded / totalMessages (投稿数 / 入力メッセージ数) */
  efficiency: number;
  /** スキップ率 = (opinionSkipped + cacheSkipped) / totalMessages */
  skipRate: number;
  /** 平均成功件数 / run */
  avgSuccessPerRun: number;
  /** 最終実行日 */
  lastRunDate: string;
}

export interface SlotPerformanceReport {
  generatedAt: string;
  windowDays: number;
  slots: SlotStats[];
  /** パフォーマンスが低いスロット（avgSuccessPerRun が最低のもの） */
  lowestSlot: string | null;
  /** パフォーマンスが高いスロット */
  highestSlot: string | null;
  recommendation: string;
}

// ----------------------------------------------------------------
// データ読み込み
// ----------------------------------------------------------------

function loadSlotSummaries(windowDays: number): SlotSummaryRecord[] {
  if (!fs.existsSync(SLOT_SUMMARY_FILE)) {
    logger.warn(`[slot-analysis] ${SLOT_SUMMARY_FILE} が見つかりません`);
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const raw = fs.readFileSync(SLOT_SUMMARY_FILE, 'utf-8');
  const records: SlotSummaryRecord[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec: SlotSummaryRecord = JSON.parse(line);
      if (rec.type !== 'slot_summary') continue;
      if (rec.dryRun) continue; // dry-run は除外
      const recDate = new Date(rec.executedAt);
      if (recDate < cutoff) continue;
      records.push(rec);
    } catch {
      // JSON parse エラーはスキップ
    }
  }

  return records;
}

// ----------------------------------------------------------------
// 集計
// ----------------------------------------------------------------

function aggregateBySlot(records: SlotSummaryRecord[]): SlotStats[] {
  const map = new Map<string, {
    runs: number;
    succeeded: number;
    errored: number;
    opinionSkipped: number;
    cacheSkipped: number;
    messages: number;
    candidates: number;
    lastDate: string;
  }>();

  for (const rec of records) {
    const existing = map.get(rec.slot) ?? {
      runs: 0, succeeded: 0, errored: 0,
      opinionSkipped: 0, cacheSkipped: 0,
      messages: 0, candidates: 0, lastDate: '',
    };
    existing.runs++;
    existing.succeeded     += rec.succeeded;
    existing.errored       += rec.errored;
    existing.opinionSkipped += rec.opinionSkipped;
    existing.cacheSkipped  += rec.cacheSkipped;
    existing.messages      += rec.totalMessages;
    existing.candidates    += rec.qualityCandidates;
    if (rec.date > existing.lastDate) existing.lastDate = rec.date;
    map.set(rec.slot, existing);
  }

  const stats: SlotStats[] = [];
  for (const [slot, d] of map.entries()) {
    const totalSkipped = d.opinionSkipped + d.cacheSkipped;
    const attempted = d.succeeded + d.errored;
    stats.push({
      slot,
      runs:               d.runs,
      totalSucceeded:     d.succeeded,
      totalErrored:       d.errored,
      totalSkipped:       totalSkipped,
      totalMessages:      d.messages,
      totalCandidates:    d.candidates,
      successRate:        attempted > 0 ? d.succeeded / attempted : 0,
      efficiency:         d.messages > 0 ? d.succeeded / d.messages : 0,
      skipRate:           d.messages > 0 ? totalSkipped / d.messages : 0,
      avgSuccessPerRun:   d.runs > 0 ? d.succeeded / d.runs : 0,
      lastRunDate:        d.lastDate,
    });
  }

  // スロット名でソート
  stats.sort((a, b) => a.slot.localeCompare(b.slot));
  return stats;
}

// ----------------------------------------------------------------
// レポート生成
// ----------------------------------------------------------------

function buildReport(slots: SlotStats[], windowDays: number): SlotPerformanceReport {
  if (slots.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      windowDays,
      slots: [],
      lowestSlot: null,
      highestSlot: null,
      recommendation: 'データ不足のため分析できません',
    };
  }

  const sorted = [...slots].sort((a, b) => a.avgSuccessPerRun - b.avgSuccessPerRun);
  const lowestSlot  = sorted[0]?.slot ?? null;
  const highestSlot = sorted[sorted.length - 1]?.slot ?? null;

  const lowest  = sorted[0];
  const highest = sorted[sorted.length - 1];

  let recommendation = '';
  if (lowest && highest && lowest.slot !== highest.slot) {
    const gap = highest.avgSuccessPerRun - lowest.avgSuccessPerRun;
    if (gap >= 2) {
      recommendation =
        `[${highest.slot}] は平均 ${highest.avgSuccessPerRun.toFixed(1)} 件/回 と高効率。` +
        `[${lowest.slot}] は ${lowest.avgSuccessPerRun.toFixed(1)} 件/回 と低い（差: ${gap.toFixed(1)} 件）。` +
        `[${lowest.slot}] の記事ソース・カテゴリ設定の見直しを推奨。`;
    } else {
      recommendation = `全スロットの効率差は ${gap.toFixed(1)} 件以内。現状維持で問題なし。`;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    slots,
    lowestSlot,
    highestSlot,
    recommendation,
  };
}

// ----------------------------------------------------------------
// 表示
// ----------------------------------------------------------------

function printReport(report: SlotPerformanceReport): void {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 スロット別投稿効率レポート（直近 ${report.windowDays} 日間）`);
  console.log(`   生成日時: ${new Date(report.generatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (report.slots.length === 0) {
    console.log('  データなし');
    return;
  }

  console.log('');
  console.log('  スロット  | 実行回 | 成功計 | 成功率  | 効率   | スキップ率 | 平均成功/回');
  console.log('  ---------|--------|--------|---------|--------|------------|------------');

  for (const s of report.slots) {
    const marker = s.slot === report.highestSlot ? '🏆' :
                   s.slot === report.lowestSlot  ? '⚠️ ' : '  ';
    console.log(
      `  ${marker}${s.slot.padEnd(8)} | ` +
      `${String(s.runs).padStart(6)} | ` +
      `${String(s.totalSucceeded).padStart(6)} | ` +
      `${(s.successRate * 100).toFixed(1).padStart(6)}% | ` +
      `${(s.efficiency * 100).toFixed(1).padStart(5)}% | ` +
      `${(s.skipRate * 100).toFixed(1).padStart(9)}% | ` +
      `${s.avgSuccessPerRun.toFixed(1).padStart(11)} 件`
    );
  }

  console.log('');
  if (report.recommendation) {
    console.log(`  💡 ${report.recommendation}`);
  }
  console.log('');
  console.log('  ※ インプレッション別最適化は X API 連携後に対応予定');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

// ----------------------------------------------------------------
// エントリポイント
// ----------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const daysArg = args.find(a => a.startsWith('--days='));
  const windowDays = daysArg ? parseInt(daysArg.split('=')[1] ?? '30', 10) : 30;
  const jsonMode   = args.includes('--json');

  logger.info(`[slot-analysis] 直近 ${windowDays} 日のデータを集計中...`);

  const records = loadSlotSummaries(windowDays);
  logger.info(`[slot-analysis] ${records.length} レコード読み込み`);

  const slots  = aggregateBySlot(records);
  const report = buildReport(slots, windowDays);

  // JSON ファイルに保存
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  logger.info(`[slot-analysis] ${OUTPUT_FILE} に保存しました`);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

main().catch((err) => {
  logger.error(`[slot-analysis] エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
