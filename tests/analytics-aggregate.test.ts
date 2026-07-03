/**
 * analytics-aggregate のユニットテスト
 *
 * 重点:
 *  - isOwnTweetUrl: 自アカウントの投稿だけを対象にする（他人の引用/RT元を除外）
 *  - buildDailyRecord: 日次サマリ集計とエンゲージ率
 *  - appendDailyRecord: 時系列 jsonl への追記（同日再実行は上書き=冪等）
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  isOwnTweetUrl,
  buildDailyRecord,
  appendDailyRecord,
  type TweetStat,
} from '../src/utils/analytics-aggregate';

describe('isOwnTweetUrl', () => {
  test('自アカウントの status URL は true', () => {
    expect(isOwnTweetUrl('/opensourcelab9/status/123', 'opensourcelab9')).toBe(true);
    expect(isOwnTweetUrl('https://x.com/opensourcelab9/status/123', 'opensourcelab9')).toBe(true);
  });

  test('他人の status URL は false（引用元/RT元の混入を防ぐ）', () => {
    expect(isOwnTweetUrl('/masahirochaen/status/999', 'opensourcelab9')).toBe(false);
    expect(isOwnTweetUrl('https://x.com/egao_ozawa/status/888', 'opensourcelab9')).toBe(false);
  });

  test('photo/video/analytics/likes などサブパスは false', () => {
    expect(isOwnTweetUrl('/opensourcelab9/status/123/photo/1', 'opensourcelab9')).toBe(false);
    expect(isOwnTweetUrl('/opensourcelab9/status/123/analytics', 'opensourcelab9')).toBe(false);
    expect(isOwnTweetUrl('/opensourcelab9/likes', 'opensourcelab9')).toBe(false);
  });

  test('username 大文字小文字を無視、@や空白に強い', () => {
    expect(isOwnTweetUrl('/OpenSourceLab9/status/123', 'opensourcelab9')).toBe(true);
    expect(isOwnTweetUrl('/opensourcelab9/status/123', '@opensourcelab9')).toBe(true);
    expect(isOwnTweetUrl('', 'opensourcelab9')).toBe(false);
    expect(isOwnTweetUrl('/opensourcelab9/status/123', '')).toBe(false);
  });
});

describe('buildDailyRecord', () => {
  const stats: TweetStat[] = [
    { url: 'a', impressions: 1000, likes: 10, retweets: 5, replies: 5 },
    { url: 'b', impressions: 3000, likes: 20, retweets: 10, replies: 0 },
    { url: 'c', impressions: null, likes: null, retweets: null, replies: null },
  ];

  test('合計・平均・エンゲージ率を集計する', () => {
    const rec = buildDailyRecord('2026-06-18', '2026-06-18T14:00:00.000Z', stats);
    expect(rec.date).toBe('2026-06-18');
    expect(rec.count).toBe(3);
    expect(rec.totalImpressions).toBe(4000);
    expect(rec.avgImpressions).toBe(1333); // 4000/3 四捨五入
    expect(rec.totalLikes).toBe(30);
    expect(rec.totalRTs).toBe(15);
    expect(rec.totalReplies).toBe(5);
    // エンゲージ率 = (30+15+5)/4000 = 0.0125
    expect(rec.engagementRate).toBeCloseTo(0.0125, 5);
  });

  test('インプレッション0なら engagementRate は 0（ゼロ除算回避）', () => {
    const rec = buildDailyRecord('2026-06-18', 'x', [
      { url: 'a', impressions: 0, likes: 1, retweets: 0, replies: 0 },
    ]);
    expect(rec.engagementRate).toBe(0);
  });
});

describe('appendDailyRecord', () => {
  const TMP_DIR = path.join(os.tmpdir(), `analytics-agg-test-${Date.now()}`);
  const FILE = path.join(TMP_DIR, 'x-analytics-daily.jsonl');

  beforeEach(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  });
  afterAll(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

  test('新規日付は追記される', () => {
    appendDailyRecord(FILE, buildDailyRecord('2026-06-17', 'x', [{ url: 'a', impressions: 100, likes: 1, retweets: 0, replies: 0 }]));
    appendDailyRecord(FILE, buildDailyRecord('2026-06-18', 'x', [{ url: 'b', impressions: 200, likes: 2, retweets: 0, replies: 0 }]));
    const lines = fs.readFileSync(FILE, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).date).toBe('2026-06-17');
    expect(JSON.parse(lines[1]).date).toBe('2026-06-18');
  });

  test('同日再実行は上書き（冪等・重複行を作らない）', () => {
    appendDailyRecord(FILE, buildDailyRecord('2026-06-18', 'x', [{ url: 'a', impressions: 100, likes: 0, retweets: 0, replies: 0 }]));
    appendDailyRecord(FILE, buildDailyRecord('2026-06-18', 'x', [{ url: 'a', impressions: 500, likes: 0, retweets: 0, replies: 0 }]));
    const lines = fs.readFileSync(FILE, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).totalImpressions).toBe(500); // 最新値で上書き
  });
});
