/**
 * kpi-collector.ts のユニットテスト
 *
 * テスト対象:
 *   - collectKpis(): 空データ・正常データ・KPI 達成判定
 *
 * モック戦略:
 *   - analytics-logger の読み込み関数をモック（ファイルシステム不要）
 */

// ── analytics-logger モック ───────────────────────────────────────

const mockReadSlotSummaries = jest.fn();
const mockReadAnalyticsRecords = jest.fn();

jest.mock('../src/utils/analytics-logger', () => ({
  readSlotSummaries:  (...args: unknown[]) => mockReadSlotSummaries(...args),
  readAnalyticsRecords: (...args: unknown[]) => mockReadAnalyticsRecords(...args),
  logAnalytics:  jest.fn(),
  logSlotSummary: jest.fn(),
}));

// logger: テスト中の出力を抑制
jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { collectKpis } from '../src/agents/kpi-collector';
import { DEFAULT_STRATEGY } from '../src/utils/strategy-store';
import { SlotRunSummary, AnalyticsRecord } from '../src/utils/analytics-logger';

// ── テスト用ファクトリ ─────────────────────────────────────────────

function makeSlotSummary(overrides: Partial<SlotRunSummary> = {}): SlotRunSummary {
  return {
    type: 'slot_summary',
    date: '2026-06-30',
    executedAt: '2026-06-30T22:30:00Z',
    slot: 'slot07',
    totalMessages: 10,
    opinionSkipped: 0,
    cacheSkipped: 0,
    qualityCandidates: 5,
    batchSize: 4,
    succeeded: 4,
    errored: 0,
    categoriesUsed: ['trend', 'business', 'startup', 'global'] as any,
    dryRun: false,
    ...overrides,
  };
}

function makeAnalyticsRecord(overrides: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    postedAt: '2026-06-30T22:30:00Z',
    slot: 'slot07',
    theme: 'trend' as any,
    source: 'chatwork',
    url: 'https://example.com/article1',
    title: 'AIニュース',
    imageAttached: false,
    success: true,
    ...overrides,
  };
}

// ── テストスイート ────────────────────────────────────────────────

describe('collectKpis', () => {
  beforeEach(() => {
    mockReadSlotSummaries.mockReset();
    mockReadAnalyticsRecords.mockReset();
  });

  // ── 空データ ──────────────────────────────────────────────────────

  it('空データ（スロットサマリなし）でもクラッシュせず KpiReport を返す', () => {
    mockReadSlotSummaries.mockReturnValue([]);
    mockReadAnalyticsRecords.mockReturnValue([]);

    const report = collectKpis(DEFAULT_STRATEGY, 7);

    expect(report).toBeDefined();
    expect(report.totalRuns).toBe(0);
    expect(report.totalPosts).toBe(0);
    expect(report.totalErrors).toBe(0);
    expect(report.categoriesUsed).toEqual([]);
  });

  it('空データでも allTargetsMet が boolean を返す', () => {
    mockReadSlotSummaries.mockReturnValue([]);
    mockReadAnalyticsRecords.mockReturnValue([]);

    const report = collectKpis(DEFAULT_STRATEGY, 7);

    // 空データはターゲット未達(false) または 一部達成(skipRate, errorRate は 0=達成)
    expect(typeof report.allTargetsMet).toBe('boolean');
  });

  // ── 正常データ ────────────────────────────────────────────────────

  it('成功スロットサマリーがある場合: totalPosts が正しく集計される', () => {
    const summaries = [
      makeSlotSummary({ slot: 'slot07', succeeded: 4, errored: 0, date: '2026-06-30' }),
      makeSlotSummary({ slot: 'slot11', succeeded: 3, errored: 1, date: '2026-06-30' }),
    ];
    mockReadSlotSummaries.mockReturnValue(summaries);
    mockReadAnalyticsRecords.mockReturnValue([
      makeAnalyticsRecord({ theme: 'trend' as any }),
      makeAnalyticsRecord({ theme: 'business' as any }),
    ]);

    const report = collectKpis(DEFAULT_STRATEGY, 7);

    expect(report.totalPosts).toBe(7);   // 4 + 3
    expect(report.totalErrors).toBe(1);  // 0 + 1
  });

  it('bySlot: 対象スロットの成功率が正しく計算される', () => {
    const summaries = [
      makeSlotSummary({ slot: 'slot07', succeeded: 8, errored: 2, date: '2026-06-30' }),
    ];
    mockReadSlotSummaries.mockReturnValue(summaries);
    mockReadAnalyticsRecords.mockReturnValue([]);

    const report = collectKpis(DEFAULT_STRATEGY, 7);

    expect(report.bySlot.slot07.successRate).toBeCloseTo(0.8, 2); // 8/(8+2)
    expect(report.bySlot.slot07.errorRate).toBeCloseTo(0.2, 2);   // 2/(8+2)
  });

  // ── KPI 達成判定 ──────────────────────────────────────────────────

  it('日次投稿数が目標以上の場合: dailyPosts.met === true', () => {
    // 15件/日 以上が目標
    const summaries = [
      makeSlotSummary({ slot: 'slot07', succeeded: 5, date: '2026-06-30' }),
      makeSlotSummary({ slot: 'slot11', succeeded: 5, date: '2026-06-30' }),
      makeSlotSummary({ slot: 'slot12', succeeded: 5, date: '2026-06-30' }),
    ];
    mockReadSlotSummaries.mockReturnValue(summaries);
    mockReadAnalyticsRecords.mockReturnValue(
      Array.from({ length: 15 }, (_, i) =>
        makeAnalyticsRecord({ theme: ['trend', 'business', 'model_release'][i % 3] as any })
      )
    );

    const report = collectKpis(DEFAULT_STRATEGY, 7);

    expect(report.targetsStatus.dailyPosts.met).toBe(true);
  });

  it('エラー率が目標内（≤10%）の場合: errorRate.met === true', () => {
    const summaries = [
      makeSlotSummary({ slot: 'slot07', succeeded: 9, errored: 1 }), // 10% = 目標値
    ];
    mockReadSlotSummaries.mockReturnValue(summaries);
    mockReadAnalyticsRecords.mockReturnValue([]);

    const report = collectKpis(DEFAULT_STRATEGY, 7);

    expect(report.targetsStatus.errorRate.met).toBe(true);
    expect(report.targetsStatus.errorRate.actual).toBeCloseTo(0.1, 2);
  });

  it('エラー率が目標超過（>10%）の場合: errorRate.met === false', () => {
    const summaries = [
      makeSlotSummary({ slot: 'slot07', succeeded: 8, errored: 2 }), // 20% > 10%
    ];
    mockReadSlotSummaries.mockReturnValue(summaries);
    mockReadAnalyticsRecords.mockReturnValue([]);

    const report = collectKpis(DEFAULT_STRATEGY, 7);

    expect(report.targetsStatus.errorRate.met).toBe(false);
  });
});
