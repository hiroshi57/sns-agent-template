/**
 * X.com 投稿分析スクリプト
 *
 * 使い方:
 *   npm run x:analytics
 *
 * 機能:
 *   - 直近の投稿からインプレッション・エンゲージメント・リンククリックを取得
 *   - analytics.twitter.com のダッシュボードデータを取得
 *   - 結果を JSON + コンソール出力
 */
import 'dotenv/config';
import { chromium, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { buildDailyRecord, appendDailyRecord, type TweetStat } from '../utils/analytics-aggregate';

const DAILY_JSONL = path.join(process.cwd(), 'data', 'x-analytics-daily.jsonl');

/**
 * KPI 計算に含める最小テキスト長。
 * 短い反応ツイート（「まさに」「良い結果」等）は自動投稿でなく
 * 手動ツイートの可能性が高いため、日次サマリから除外する。
 */
const MIN_TWEET_TEXT_LEN = 30;

const SESSION_FILE = path.join(process.cwd(), 'state', 'x-session.json');
const RESULTS_DIR = path.join(process.cwd(), 'data');

interface TweetStats {
  url: string;
  text: string;
  postedAt: string;
  impressions: number | null;
  engagements: number | null;
  linkClicks: number | null;
  likes: number | null;
  retweets: number | null;
  replies: number | null;
}

async function getTweetStats(page: Page, tweetUrl: string, postedAt: string): Promise<TweetStats> {
  const stats: TweetStats = {
    url: tweetUrl,
    text: '',
    postedAt,
    impressions: null,
    engagements: null,
    linkClicks: null,
    likes: null,
    retweets: null,
    replies: null,
  };

  try {
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // ツイート本文
    const textEl = page.locator('[data-testid="tweetText"]').first();
    stats.text = ((await textEl.textContent().catch(() => '')) ?? '').slice(0, 80);

    // インプレッション（自分のツイートページで表示される）
    // "N views" または "N インプレッション"
    const analyticsBar = page.locator('[aria-label*="view"], [aria-label*="インプレッション"], [data-testid="analyticsButton"]').first();
    if (await analyticsBar.isVisible({ timeout: 3000 }).catch(() => false)) {
      const label = (await analyticsBar.getAttribute('aria-label')) ?? '';
      const num = label.match(/[\d,]+/);
      if (num) stats.impressions = parseInt(num[0].replace(/,/g, ''), 10);
    }

    // インプレッション数（別セレクタ）
    if (!stats.impressions) {
      const viewsEl = page.locator('span:has-text(" views"), a[href*="/analytics"]').first();
      if (await viewsEl.isVisible({ timeout: 2000 }).catch(() => false)) {
        const txt = await viewsEl.textContent() || '';
        const num = txt.replace(/,/g, '').match(/[\d.]+[KMk]?/);
        if (num) {
          const raw = num[0];
          if (raw.toLowerCase().endsWith('k')) stats.impressions = Math.round(parseFloat(raw) * 1000);
          else if (raw.toLowerCase().endsWith('m')) stats.impressions = Math.round(parseFloat(raw) * 1000000);
          else stats.impressions = parseInt(raw, 10);
        }
      }
    }

    // いいね数
    const likeBtn = page.locator('[data-testid="like"] span, [aria-label*="いいね"] span').first();
    if (await likeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      const txt = (await likeBtn.textContent() || '').replace(/,/g, '');
      if (txt) stats.likes = parseInt(txt, 10) || 0;
    }

    // リツイート数
    const rtBtn = page.locator('[data-testid="retweet"] span, [data-testid="unretweet"] span').first();
    if (await rtBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      const txt = (await rtBtn.textContent() || '').replace(/,/g, '');
      if (txt) stats.retweets = parseInt(txt, 10) || 0;
    }

    // 返信数
    const replyBtn = page.locator('[data-testid="reply"] span').first();
    if (await replyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      const txt = (await replyBtn.textContent() || '').replace(/,/g, '');
      if (txt) stats.replies = parseInt(txt, 10) || 0;
    }

  } catch (err) {
    logger.warn(`取得失敗: ${tweetUrl.slice(-30)} — ${err instanceof Error ? err.message : String(err)}`);
  }

  return stats;
}

async function getProfileTweets(page: Page): Promise<Array<{ tweetUrl: string; postedAt: string }>> {
  // 投稿済みキャッシュから今日のURLを取得
  const cacheFile = path.join(process.cwd(), 'data', 'x-posted-urls.json');
  if (!fs.existsSync(cacheFile)) return [];

  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const entries: Array<{ url: string; postedAt: string }> = cache.entries ?? [];

  // 今日の投稿に絞る（JST）
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const todayEntries = entries.filter(e => e.postedAt && e.postedAt.startsWith(todayStr));

  // X.com のプロフィールページからツイート URL を取得
  logger.info(`プロフィールページでツイートURLを収集中...`);
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // 左サイドバーのアカウント名からプロフィールURLを取得
  const profileLink = page.locator('[data-testid="AppTabBar_Profile_Link"]').first();
  const profileHref = await profileLink.getAttribute('href').catch(() => null);
  const username = profileHref?.replace('/', '') ?? '';

  if (!username) {
    logger.warn('ユーザー名を取得できませんでした');
    return todayEntries.map(e => ({ tweetUrl: e.url, postedAt: e.postedAt }));
  }

  logger.info(`ユーザー名: @${username}`);
  await page.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // タイムラインからツイートリンクを収集
  const tweetLinks = await page.locator('article a[href*="/status/"]').all();
  const tweetUrls = new Set<string>();
  for (const link of tweetLinks.slice(0, 30)) {
    const href = await link.getAttribute('href').catch(() => '');
    if (href?.includes('/status/') && !href.includes('/photo/') && !href.includes('/video/')) {
      tweetUrls.add(`https://x.com${href}`);
    }
  }

  logger.info(`プロフィールから ${tweetUrls.size} 件のツイートURLを収集`);

  // キャッシュのエントリとマッチング（今日の投稿）
  return todayEntries.map(e => ({
    tweetUrl: [...tweetUrls].find(u => tweetUrls.has(u)) ?? e.url,
    postedAt: e.postedAt,
  }));
}

function formatNum(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

async function main(): Promise<void> {
  logger.info('=== X.com 投稿分析 ===');

  if (!fs.existsSync(SESSION_FILE)) {
    logger.error('セッションがありません。npm run x:setup を実行してください。');
    process.exit(1);
  }

  const isCI = process.env['CI'] === 'true';
  const browser = await chromium.launch({
    headless: isCI,
    args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
  });

  try {
    const context = await browser.newContext({ storageState: SESSION_FILE });
    const page = await context.newPage();

    // セッション確認
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const hasSideNav = await page.locator('[data-testid="SideNav_NewTweet_Button"]')
      .isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasSideNav) {
      logger.error('ログインセッションが切れています。npm run x:setup を実行してください。');
      process.exit(1);
    }

    // 今日の投稿一覧を取得
    const entries = await getProfileTweets(page);
    logger.info(`分析対象: ${entries.length} 件`);

    // X.com のプロフィールページからツイートリンクを収集
    const profileLink = page.locator('[data-testid="AppTabBar_Profile_Link"]').first();
    const profileHref = await profileLink.getAttribute('href').catch(() => null);
    const username = profileHref?.replace('/', '') ?? '';

    await page.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    const tweetLinkEls = await page.locator('article a[href*="/status/"]').all();
    const tweetUrls: string[] = [];
    for (const link of tweetLinkEls) {
      const href = await link.getAttribute('href').catch(() => '');
      if (href && href.includes('/status/') && !href.includes('/photo/') && !href.includes('/video/') && !href.includes('/retweets') && !href.includes('/likes')) {
        const full = `https://x.com${href}`;
        if (!tweetUrls.includes(full)) tweetUrls.push(full);
      }
    }
    logger.info(`プロフィールから ${tweetUrls.length} 件のツイートURL収集`);

    // 各ツイートの統計を取得（直近20件）
    const results: TweetStats[] = [];
    const targets = tweetUrls.slice(0, 20);

    for (let i = 0; i < targets.length; i++) {
      const url = targets[i];
      logger.info(`[${i + 1}/${targets.length}] 分析中: ${url.slice(-30)}`);
      const stats = await getTweetStats(page, url, entries[i]?.postedAt ?? '');
      results.push(stats);
      await page.waitForTimeout(1500);
    }

    // ── 集計 ──
    const totalImp = results.reduce((s, r) => s + (r.impressions ?? 0), 0);
    const totalLikes = results.reduce((s, r) => s + (r.likes ?? 0), 0);
    const totalRTs = results.reduce((s, r) => s + (r.retweets ?? 0), 0);
    const totalReplies = results.reduce((s, r) => s + (r.replies ?? 0), 0);
    const avgImp = results.length > 0 ? Math.round(totalImp / results.length) : 0;

    // ── コンソール出力 ──
    logger.info('\n========================================');
    logger.info('  📊 X.com 投稿分析レポート（本日分）');
    logger.info('========================================');
    logger.info(`  投稿数         : ${results.length} 件`);
    logger.info(`  合計インプレッション: ${formatNum(totalImp)}`);
    logger.info(`  平均インプレッション: ${formatNum(avgImp)}`);
    logger.info(`  合計いいね     : ${formatNum(totalLikes)}`);
    logger.info(`  合計リツイート : ${formatNum(totalRTs)}`);
    logger.info(`  合計リプライ   : ${formatNum(totalReplies)}`);
    logger.info('');
    logger.info('  ── 投稿別詳細 ──');

    // インプレッション順にソート
    const sorted = [...results].sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0));
    for (const r of sorted) {
      const title = r.text.slice(0, 40) || r.url.slice(-40);
      logger.info(`  IMP:${formatNum(r.impressions).padStart(6)} | ♥:${formatNum(r.likes).padStart(4)} | RT:${formatNum(r.retweets).padStart(4)} | ${title}`);
    }

    const generatedAt = new Date().toISOString();

    // ── JSON 保存（生データ全件）──
    const outFile = path.join(RESULTS_DIR, `x-analytics-${generatedAt.slice(0, 10)}.json`);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({
      generatedAt,
      summary: { count: results.length, totalImpressions: totalImp, avgImpressions: avgImp, totalLikes, totalRTs, totalReplies },
      tweets: sorted,
    }, null, 2), 'utf-8');
    logger.info(`\n  💾 保存: ${outFile}`);

    // ── x-analytics-daily.jsonl に日次サマリを追記 ──
    // 短い手動反応ツイートを除外し、自動投稿コンテンツのみで KPI を計算する。
    const autoStats: TweetStat[] = results
      .filter(r => (r.text ?? '').length >= MIN_TWEET_TEXT_LEN)
      .map(r => ({
        url: r.url,
        impressions: r.impressions,
        likes: r.likes,
        retweets: r.retweets,
        replies: r.replies,
      }));

    if (autoStats.length > 0) {
      const dailyRec = buildDailyRecord(generatedAt.slice(0, 10), generatedAt, autoStats);
      appendDailyRecord(DAILY_JSONL, dailyRec);
      logger.info(`  📈 日次サマリ更新: ${autoStats.length}件 avg ${dailyRec.avgImpressions} imp → ${DAILY_JSONL.split(/[\\/]/).pop()}`);
    } else {
      logger.warn('  ⚠️  有効な投稿データなし（長さフィルタで全件除外）。日次サマリは更新しません。');
    }

    logger.info('========================================\n');

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
