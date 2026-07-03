/**
 * X 投稿アナリティクスの集計ユーティリティ（副作用なしの純粋ロジック中心）
 *
 * analytics-scraper.ts から利用する。Playwright 非依存なので単体テスト可能。
 *
 *  - isOwnTweetUrl   : 自アカウントの投稿URLだけを対象にする（引用元/RT元の他人を除外）
 *  - buildDailyRecord: 1日分のツイート統計を日次サマリに集計
 *  - appendDailyRecord: 時系列 jsonl に追記（同日は上書き＝冪等）
 */
import fs from 'fs';
import path from 'path';

export interface TweetStat {
  url: string;
  impressions: number | null;
  likes: number | null;
  retweets: number | null;
  replies: number | null;
}

export interface DailyAnalyticsRecord {
  /** 集計対象日 (YYYY-MM-DD) */
  date: string;
  /** 集計実行時刻 (ISO) */
  generatedAt: string;
  /** 対象投稿数 */
  count: number;
  totalImpressions: number;
  avgImpressions: number;
  totalLikes: number;
  totalRTs: number;
  totalReplies: number;
  /** エンゲージ率 = (likes + RT + replies) / impressions（0除算時は0） */
  engagementRate: number;
}

/**
 * href が「ログイン中ユーザー自身の投稿」かどうかを判定する。
 *
 * プロフィールページの article には引用元・RT元など他人の status リンクも
 * 含まれるため、`/{username}/status/<id>` 形式のみを true とする。
 * photo/video/analytics/likes/retweets などのサブパスは除外。
 */
export function isOwnTweetUrl(href: string, username: string): boolean {
  if (typeof href !== 'string' || href.trim() === '') return false;
  const user = String(username).replace(/^@/, '').trim().toLowerCase();
  if (user === '') return false;

  // 絶対URL/相対URLどちらでもパス部分を取り出す
  const pathPart = href.replace(/^https?:\/\/[^/]+/i, '');
  const m = pathPart.match(/^\/([^/]+)\/status\/(\d+)\/?$/i);
  if (!m) return false;
  return m[1].toLowerCase() === user;
}

/** 1日分のツイート統計を日次サマリレコードに集計する */
export function buildDailyRecord(
  date: string,
  generatedAt: string,
  stats: TweetStat[],
): DailyAnalyticsRecord {
  const sum = (sel: (t: TweetStat) => number | null): number =>
    stats.reduce((acc, t) => acc + (sel(t) ?? 0), 0);

  const totalImpressions = sum(t => t.impressions);
  const totalLikes = sum(t => t.likes);
  const totalRTs = sum(t => t.retweets);
  const totalReplies = sum(t => t.replies);
  const count = stats.length;
  const avgImpressions = count > 0 ? Math.round(totalImpressions / count) : 0;
  const engagementRate =
    totalImpressions > 0
      ? (totalLikes + totalRTs + totalReplies) / totalImpressions
      : 0;

  return {
    date,
    generatedAt,
    count,
    totalImpressions,
    avgImpressions,
    totalLikes,
    totalRTs,
    totalReplies,
    engagementRate,
  };
}

/**
 * 日次サマリを時系列 jsonl に追記する。
 * 同じ date の行が既にある場合は最新値で置き換える（再実行で重複させない）。
 */
export function appendDailyRecord(file: string, record: DailyAnalyticsRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let records: DailyAnalyticsRecord[] = [];
  if (fs.existsSync(file)) {
    records = fs
      .readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(l => {
        try {
          return JSON.parse(l) as DailyAnalyticsRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is DailyAnalyticsRecord => r !== null);
  }

  const filtered = records.filter(r => r.date !== record.date);
  filtered.push(record);
  filtered.sort((a, b) => a.date.localeCompare(b.date));

  fs.writeFileSync(file, filtered.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}
