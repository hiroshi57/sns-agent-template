/**
 * apps/dashboard/app/lib/github-data.ts
 *
 * GitHub Raw URL 経由で data/ ファイルを取得し、ダッシュボード用に整形するユーティリティ。
 * Vercel KV 不要・public リポジトリなら認証不要。
 */

const GH_REPO   = 'YOUR_GITHUB_USERNAME/YOUR_REPO';
const GH_BRANCH = 'main';
const RAW_BASE  = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}`;

/** Vercel の ISR: 60 秒キャッシュ（更新ボタンで即反映） */
const REVALIDATE = 60;

// ── 汎用フェッチ ────────────────────────────────────────────────

export async function fetchRawJson<T>(filePath: string): Promise<T | null> {
  try {
    const res = await fetch(`${RAW_BASE}/${filePath}`, {
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchRawJsonl<T>(
  filePath: string,
  windowDays = 14,
): Promise<T[]> {
  try {
    const res = await fetch(`${RAW_BASE}/${filePath}`, {
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) return [];
    const text = await res.text();
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    return text
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as T; }
        catch { return null; }
      })
      .filter((r): r is T => r !== null)
      .filter((r: unknown) => {
        const rec = r as Record<string, unknown>;
        const ts = rec['postedAt'] ?? rec['executedAt'] ?? rec['savedAt'];
        return typeof ts === 'string' ? new Date(ts).getTime() > cutoff : true;
      });
  } catch {
    return [];
  }
}

// ── 型定義 ──────────────────────────────────────────────────────

interface AnalyticsRecord {
  postedAt:  string;
  slot:      string;
  platform?: string;
  theme:     string;
  source:    string;
  title?:    string;
  url?:      string;
  success:   boolean;
}

interface SlotRunSummary {
  type:       string;
  date:       string;
  executedAt: string;
  slot:       string;
  succeeded:  number;
  errored:    number;
}

interface DailyAnalyticsFile {
  generatedAt: string;
  summary: { count: number; totalImpressions: number; avgImpressions: number };
  tweets: Array<{
    url:         string;
    text:        string;
    postedAt:    string;
    impressions: number | null;
  }>;
}

// ── 日次 JSON → AnalyticsRecord 変換 ────────────────────────────

/** 時刻（JST時）からスロット名を推定 */
function inferSlot(hourJst: number): string {
  if (hourJst < 9)  return 'slot07';
  if (hourJst < 12) return 'slot11';
  if (hourJst < 14) return 'slot12';
  if (hourJst < 17) return 'slot14';
  return 'slot17';
}

/**
 * x-analytics-YYYY-MM-DD.json を読み込み AnalyticsRecord[] に変換する。
 * postedAt が空の場合はファイル名の日付の正午 JST を使用。
 */
async function fetchDailyRecords(dateStr: string): Promise<AnalyticsRecord[]> {
  const file = await fetchRawJson<DailyAnalyticsFile>(
    `data/x-analytics-${dateStr}.json`
  );
  if (!file?.tweets?.length) return [];

  return file.tweets.map((t, i) => {
    // postedAt が空の場合: ファイル日付 + 8:00 JST + index 分
    let postedAt = t.postedAt;
    if (!postedAt) {
      const base = new Date(`${dateStr}T08:00:00+09:00`);
      base.setMinutes(base.getMinutes() + i * 3);
      postedAt = base.toISOString();
    }
    const hourJst = new Date(new Date(postedAt).getTime() + 9 * 3600_000).getUTCHours();
    return {
      postedAt,
      slot:     inferSlot(hourJst),
      platform: 'x',
      theme:    'trend',
      source:   'x_analytics',
      title:    t.text?.slice(0, 60),
      url:      t.url,
      success:  true,
    };
  });
}

// ── analytics:stats の構築 ─────────────────────────────────────

export async function buildStats() {
  // x-analytics.jsonl（詳細データ）を取得
  const baseRecords = await fetchRawJsonl<AnalyticsRecord>('data/x-analytics.jsonl', 90);

  // x-analytics.jsonl にデータがない日を日次 JSON で補完（直近14日）
  const days14 = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() + 9 * 3600_000 - i * 86_400_000);
    return d.toISOString().slice(0, 10);
  });

  const coveredDates = new Set(
    baseRecords.map(r =>
      new Date(new Date(r.postedAt).getTime() + 9 * 3600_000).toISOString().slice(0, 10)
    )
  );

  const supplemental = (
    await Promise.all(
      days14
        .filter(d => !coveredDates.has(d))
        .map(d => fetchDailyRecords(d))
    )
  ).flat();

  const records = [...baseRecords, ...supplemental];

  const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  const days7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() + 9 * 3600_000 - i * 86_400_000);
    return d.toISOString().slice(0, 10);
  }).reverse();

  const todayRecords = records.filter(r => {
    const jst = new Date(new Date(r.postedAt).getTime() + 9 * 3600_000);
    return jst.toISOString().slice(0, 10) === todayJst;
  });

  const success   = todayRecords.filter(r => r.success);
  const errorRate = todayRecords.length > 0
    ? Math.round((todayRecords.filter(r => !r.success).length / todayRecords.length) * 100)
    : 0;

  // 日別 × プラットフォーム集計
  const daily: Record<string, Record<string, number>> = {};
  for (const day of days7) daily[day] = {};
  for (const r of records) {
    const jst = new Date(new Date(r.postedAt).getTime() + 9 * 3600_000);
    const day = jst.toISOString().slice(0, 10);
    if (!daily[day]) continue;
    const pf = r.platform ?? 'x';
    daily[day][pf] = (daily[day][pf] ?? 0) + (r.success ? 1 : 0);
  }

  const bySlot: Record<string, number> = {};
  for (const r of success) bySlot[r.slot] = (bySlot[r.slot] ?? 0) + 1;

  const byTheme: Record<string, number> = {};
  for (const r of success) byTheme[r.theme] = (byTheme[r.theme] ?? 0) + 1;

  const bySource: Record<string, number> = {};
  for (const r of success) bySource[r.source] = (bySource[r.source] ?? 0) + 1;

  const platformSummary: Record<string, { count: number }> = {};
  for (const r of success) {
    const pf = r.platform ?? 'x';
    if (!platformSummary[pf]) platformSummary[pf] = { count: 0 };
    platformSummary[pf].count++;
  }

  const weeklyKpi = days7.map(day => {
    const count = records.filter(r => {
      const jst = new Date(new Date(r.postedAt).getTime() + 9 * 3600_000);
      return jst.toISOString().slice(0, 10) === day && r.success;
    }).length;
    return { date: day, count };
  });

  const recent = [...records]
    .filter(r => r.success)
    .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    .slice(0, 200)
    .map(r => ({
      postedAt: r.postedAt,
      platform: r.platform ?? 'x',
      title:    r.title ?? r.theme,
      theme:    r.theme,
      slot:     r.slot,
      url:      r.url,
      success:  r.success,
    }));

  return {
    today: todayJst,
    kpi:   { target: 15, actual: success.length, errorRate },
    daily,
    days:  days7,
    bySlot,
    byTheme,
    bySource,
    platformSummary,
    weeklyKpi,
    recent,
    updatedAt: new Date().toISOString(),
    _source: 'github-raw',
  };
}

// ── analytics:slots の構築 ─────────────────────────────────────

export async function buildSlots() {
  const summaries = await fetchRawJsonl<SlotRunSummary>('data/x-slot-summary.jsonl', 35);
  const todayJst  = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const today     = summaries.filter(s => s.date === todayJst);
  const history   = [...summaries]
    .sort((a, b) => new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime())
    .slice(-100);
  return { today, history, _source: 'github-raw' };
}

// ── affiliate:data の構築 ──────────────────────────────────────

interface AffiliatePost {
  postedAt:     string;
  platform:     string;
  products:     Array<{ rank: number; id: string; name: string; price?: number; affiliateUrl: string }>;
  rankingTitle: string;
  success:      boolean;
  dryRun:       boolean;
}

export async function buildAffiliate() {
  const products    = await fetchRawJson<unknown[]>('data/affiliate-products.json') ?? [];
  const rawPosts    = await fetchRawJsonl<AffiliatePost>('data/affiliate-post-log.jsonl', 30);
  const recentPosts = [...rawPosts]
    .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    .slice(0, 20);
  return { products, recentPosts, totalPosts: rawPosts.length, _source: 'github-raw' };
}
