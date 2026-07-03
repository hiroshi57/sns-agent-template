/**
 * scripts/sync-kv.ts
 *
 * GitHub Actions 実行後に呼び出すデータ同期スクリプト。
 * ローカル data/ ファイルを読み込み、Vercel KV（Upstash Redis REST API）へ書き込む。
 *
 * 必要な環境変数:
 *   KV_REST_API_URL   - Vercel KV の REST エンドポイント
 *   KV_REST_API_TOKEN - Vercel KV の Bearer トークン
 *
 * 使用方法:
 *   npx ts-node scripts/sync-kv.ts
 *   npx ts-node scripts/sync-kv.ts --dry-run
 */

import fs from 'fs';
import path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const DATA_DIR = path.join(process.cwd(), 'data');

// ── Vercel KV REST API ──────────────────────────────────────────

const KV_URL   = process.env['KV_REST_API_URL']   ?? '';
const KV_TOKEN = process.env['KV_REST_API_TOKEN'] ?? '';

// dry-run では KV へ書き込まないため認証情報は不要（集計内容の確認用）
if (!DRY_RUN && (!KV_URL || !KV_TOKEN)) {
  console.error('❌ KV_REST_API_URL または KV_REST_API_TOKEN が未設定です');
  process.exit(1);
}

async function kvSet(key: string, value: unknown): Promise<void> {
  if (DRY_RUN) {
    console.log(`[dry-run] SET ${key} (${JSON.stringify(value).slice(0, 60)}...)`);
    return;
  }
  const body = JSON.stringify(value);
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KV SET ${key} failed (${res.status}): ${text}`);
  }
  console.log(`✅ SET ${key}`);
}

// ── ファイル読み込みヘルパー ────────────────────────────────────

function readJsonlFile<T>(filePath: string, windowDays = 7): T[] {
  if (!fs.existsSync(filePath)) return [];
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) as T; } catch { return null; } })
    .filter((r): r is T => r !== null)
    .filter((r: unknown) => {
      const rec = r as Record<string, unknown>;
      const ts = rec['postedAt'] ?? rec['executedAt'] ?? rec['savedAt'];
      return typeof ts === 'string' ? new Date(ts).getTime() > cutoff : true;
    });
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T; }
  catch { return null; }
}

// ── 型定義 ──────────────────────────────────────────────────────

interface AnalyticsRecord {
  postedAt: string;
  slot: string;
  platform?: string;
  theme: string;
  source: string;
  title?: string;
  success: boolean;
}

interface SlotRunSummary {
  type: string;
  date: string;
  executedAt: string;
  slot: string;
  succeeded: number;
  errored: number;
}

// ── analytics:stats の構築 ─────────────────────────────────────

function buildStats(records: AnalyticsRecord[], summaries: SlotRunSummary[]) {
  const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  // 直近7日
  const days7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() + 9 * 3600 * 1000 - i * 86400000);
    return d.toISOString().slice(0, 10);
  }).reverse();

  const todayRecords = records.filter(r => {
    const jst = new Date(new Date(r.postedAt).getTime() + 9 * 3600 * 1000);
    return jst.toISOString().slice(0, 10) === todayJst;
  });

  const success = todayRecords.filter(r => r.success);
  const errorRate = todayRecords.length > 0
    ? Math.round((todayRecords.filter(r => !r.success).length / todayRecords.length) * 100)
    : 0;

  // 日別 × プラットフォーム集計
  const daily: Record<string, Record<string, number>> = {};
  for (const day of days7) daily[day] = {};
  for (const r of records) {
    const jst = new Date(new Date(r.postedAt).getTime() + 9 * 3600 * 1000);
    const day = jst.toISOString().slice(0, 10);
    if (!daily[day]) continue;
    const pf = r.platform ?? 'x';
    daily[day][pf] = (daily[day][pf] ?? 0) + (r.success ? 1 : 0);
  }

  // bySlot (本日)
  const bySlot: Record<string, number> = {};
  for (const r of todayRecords.filter(r => r.success)) {
    bySlot[r.slot] = (bySlot[r.slot] ?? 0) + 1;
  }

  // byTheme (本日)
  const byTheme: Record<string, number> = {};
  for (const r of todayRecords.filter(r => r.success)) {
    byTheme[r.theme] = (byTheme[r.theme] ?? 0) + 1;
  }

  // bySource (本日)
  const bySource: Record<string, number> = {};
  for (const r of todayRecords.filter(r => r.success)) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  }

  // platformSummary (本日)
  const platformSummary: Record<string, { count: number }> = {};
  for (const r of success) {
    const pf = r.platform ?? 'x';
    if (!platformSummary[pf]) platformSummary[pf] = { count: 0 };
    platformSummary[pf].count++;
  }

  // weeklyKpi (直近7日)
  const weeklyKpi = days7.map(day => {
    const count = records.filter(r => {
      const jst = new Date(new Date(r.postedAt).getTime() + 9 * 3600 * 1000);
      return jst.toISOString().slice(0, 10) === day && r.success;
    }).length;
    return { date: day, count };
  });

  // recent (直近20件)
  const recent = [...records]
    .filter(r => r.success)
    .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    .slice(0, 20)
    .map(r => ({
      postedAt: r.postedAt,
      platform: r.platform ?? 'x',
      title: r.title ?? r.theme,
      theme: r.theme,
      success: r.success,
    }));

  return {
    today: todayJst,
    kpi: { target: 20, actual: success.length, errorRate },
    daily,
    days: days7,
    bySlot,
    byTheme,
    bySource,
    platformSummary,
    weeklyKpi,
    recent,
    updatedAt: new Date().toISOString(),
  };
}

// ── analytics:slots の構築 ─────────────────────────────────────

function buildSlots(summaries: SlotRunSummary[]) {
  const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const today = summaries.filter(s => s.date === todayJst);
  const history = [...summaries]
    .sort((a, b) => new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime())
    .slice(-100);
  return { today, history };
}

// ── affiliate:data の構築 ──────────────────────────────────────

interface AffiliatePost {
  postedAt: string;
  platform: string;
  products: Array<{ rank: number; id: string; name: string; price?: number; affiliateUrl: string }>;
  rankingTitle: string;
  success: boolean;
  dryRun: boolean;
}

function buildAffiliate() {
  const products = readJsonFile<unknown[]>(path.join(DATA_DIR, 'affiliate-products.json')) ?? [];
  const posts = readJsonlFile<AffiliatePost>(path.join(DATA_DIR, 'affiliate-post-log.jsonl'), 30);
  const recentPosts = [...posts]
    .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    .slice(0, 20);
  return { products, recentPosts, totalPosts: posts.length };
}

// ── メイン ──────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔄 Vercel KV 同期開始 ${DRY_RUN ? '(dry-run)' : ''}`);
  console.log(`   エンドポイント: ${KV_URL.slice(0, 40)}...`);

  // データ読み込み
  const records   = readJsonlFile<AnalyticsRecord>(path.join(DATA_DIR, 'x-analytics.jsonl'), 14);
  const summaries = readJsonlFile<SlotRunSummary>(path.join(DATA_DIR, 'x-slot-summary.jsonl'), 35);
  const strategy  = readJsonFile<unknown>(path.join(DATA_DIR, 'strategy.json'));

  console.log(`   analytics records: ${records.length}件`);
  console.log(`   slot summaries: ${summaries.length}件`);
  console.log(`   strategy: ${strategy ? '有り' : 'なし'}`);

  // KV へ書き込み
  await kvSet('analytics:stats', buildStats(records, summaries));
  await kvSet('analytics:slots', buildSlots(summaries));
  if (strategy) await kvSet('strategy', strategy);
  await kvSet('affiliate:data', buildAffiliate());

  console.log('\n✅ 同期完了\n');
}

main().catch(err => {
  console.error('❌ sync-kv 失敗:', err);
  process.exit(1);
});
