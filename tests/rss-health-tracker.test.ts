/**
 * RssHealthTracker のユニットテスト
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { RssHealthTracker } from '../src/utils/rss-health-tracker';

// テスト用の一時ファイルに向ける
const TMP_DIR = path.join(os.tmpdir(), `rss-health-test-${Date.now()}`);
const TMP_STATE_FILE = path.join(TMP_DIR, 'data', 'rss-dead-sources.json');

beforeAll(() => {
  fs.mkdirSync(path.join(TMP_DIR, 'data'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('RssHealthTracker', () => {
  let tracker: RssHealthTracker;

  beforeEach(() => {
    // 各テスト前に一時状態ファイルを削除してリセット
    if (fs.existsSync(TMP_STATE_FILE)) fs.unlinkSync(TMP_STATE_FILE);
    tracker = new RssHealthTracker(TMP_STATE_FILE);
  });

  test('成功を記録してもデッドにならない', () => {
    tracker.record('techcrunch', true);
    tracker.record('techcrunch', true);
    expect(tracker.isDead('techcrunch')).toBe(false);
  });

  test('3回連続失敗でデッド判定', () => {
    tracker.record('verge', false);
    tracker.record('verge', false);
    expect(tracker.isDead('verge')).toBe(false); // 2回はまだ
    tracker.record('verge', false);
    expect(tracker.isDead('verge')).toBe(true);  // 3回でデッド
  });

  test('失敗後に成功するとデッドが解除される', () => {
    tracker.record('mit', false);
    tracker.record('mit', false);
    tracker.record('mit', false);
    expect(tracker.isDead('mit')).toBe(true);

    tracker.record('mit', true); // 復活
    expect(tracker.isDead('mit')).toBe(false);
  });

  test('getDeadSources は死亡中のソースのみ返す', () => {
    tracker.record('arxiv', false);
    tracker.record('arxiv', false);
    tracker.record('arxiv', false);
    tracker.record('github', true);

    const dead = tracker.getDeadSources();
    expect(dead).toHaveLength(1);
    expect(dead[0].source).toBe('arxiv');
    expect(dead[0].consecutiveFails).toBe(3);
  });

  test('buildWeeklyReport はデッドなし時に正常メッセージを返す', () => {
    const report = tracker.buildWeeklyReport();
    expect(report).toContain('正常動作中');
  });

  test('buildWeeklyReport はデッドあり時にソース名を含む', () => {
    tracker.record('wired', false);
    tracker.record('wired', false);
    tracker.record('wired', false);

    const report = tracker.buildWeeklyReport();
    expect(report).toContain('wired');
    expect(report).toContain('死亡中');
  });

  test('save と load でデータが永続化される', () => {
    tracker.record('huggingface', false);
    tracker.record('huggingface', false);
    tracker.record('huggingface', false);
    tracker.save();

    // 同じ一時ファイルを使う新しいインスタンスで読み込み
    const tracker2 = new RssHealthTracker(TMP_STATE_FILE);
    expect(tracker2.isDead('huggingface')).toBe(true);
  });
});
