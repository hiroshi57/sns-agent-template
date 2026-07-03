/**
 * affiliate-schedule のユニットテスト
 *
 * pm2 は cron ジョブ登録時に1回即実行するため、
 * 「スケジュール対象日(既定: 月曜)以外は実投稿をスキップ」して
 * 登録時の予定外投稿を防ぐ。dryRun / force は常に許可。
 */
import { shouldRunAffiliatePost } from '../src/utils/affiliate-schedule';

// 2026-06-19 は金曜、2026-06-22 は月曜
const FRIDAY = new Date('2026-06-19T03:00:00Z');
const MONDAY = new Date('2026-06-22T03:00:00Z');

describe('shouldRunAffiliatePost', () => {
  test('スケジュール対象日(月曜)は実行する', () => {
    expect(shouldRunAffiliatePost({ now: MONDAY })).toBe(true);
  });

  test('対象日以外(金曜)はスキップする', () => {
    expect(shouldRunAffiliatePost({ now: FRIDAY })).toBe(false);
  });

  test('dryRun は曜日に関わらず許可（検証用）', () => {
    expect(shouldRunAffiliatePost({ now: FRIDAY, dryRun: true })).toBe(true);
  });

  test('force は曜日に関わらず許可（手動強制）', () => {
    expect(shouldRunAffiliatePost({ now: FRIDAY, force: true })).toBe(true);
  });

  test('scheduledDow を変えれば別曜日に対応', () => {
    // 金曜 = 5
    expect(shouldRunAffiliatePost({ now: FRIDAY, scheduledDow: 5 })).toBe(true);
    expect(shouldRunAffiliatePost({ now: MONDAY, scheduledDow: 5 })).toBe(false);
  });
});
