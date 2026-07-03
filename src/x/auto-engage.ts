/**
 * X 自動エンゲージメント（施策A）
 *
 * 人気 AI アカウントの最新ツイートを引用し、Claude が生成した日本語考察コメントを付けて投稿。
 *
 * 【なぜ効くか】
 *   - 孤立ボット投稿 → avg 1 imp（X アルゴリズムに抑制される）
 *   - 人気ツイートへの引用/リプライ → 50〜200 imp（引用元オーディエンスに乗れる）
 *
 * 【実行タイミング】
 *   09:00 / 15:00 / 21:00 JST（pm2 x-auto-engage-* として3ジョブ）
 */
import Anthropic from '@anthropic-ai/sdk';
import { XPoster } from './poster';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

// ── ターゲットアカウント（引用元候補） ──────────────────────────────
// いいね数の多いオリジナルツイートを持つ大手 AI アカウントを列挙。
// 順番はスクレイプ優先度（先ほど並べたほうが先に候補になる）。
export const TARGET_ACCOUNTS = [
  'OpenAI',
  'AnthropicAI',
  'GoogleDeepMind',
  'sama',          // Sam Altman
  'ylecun',        // Yann LeCun
  'karpathy',      // Andrej Karpathy
  'HuggingFace',
  'MistralAI',
  'xai',           // xAI / Grok
  'MetaAI',
  'Scale_AI',
  'demishassabis', // DeepMind CEO
];

// ── 引用済みキャッシュ（同じツイートを重複引用しない）─────────────
const CACHE_FILE = path.join(process.cwd(), 'data', 'auto-engage-cache.json');

interface Cache {
  quoted: Record<string, string>; // tweetUrl → ISO datetime
}

function loadCache(): Cache {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Cache;
    }
  } catch { /* ignore */ }
  return { quoted: {} };
}

function saveCache(cache: Cache): void {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

function purgeOldEntries(cache: Cache): void {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [url, date] of Object.entries(cache.quoted)) {
    if (new Date(date).getTime() < sevenDaysAgo) delete cache.quoted[url];
  }
}

// ── ツイート候補 ────────────────────────────────────────────────────

export interface TweetCandidate {
  url: string;
  text: string;
  likes: number;
  account: string;
}

/** "1.2K" / "45" / "2M" などをパースして数値に変換 */
function parseLikeCount(raw: string): number {
  const t = (raw || '').trim().replace(/,/g, '');
  if (/k/i.test(t)) return Math.round(parseFloat(t) * 1_000);
  if (/m/i.test(t)) return Math.round(parseFloat(t) * 1_000_000);
  return parseInt(t, 10) || 0;
}

/**
 * ターゲットアカウントのプロフィールタイムラインをスクレイプして引用候補を収集。
 * XPoster の homePage（open() 済み）を使い、ブラウザを使い回す。
 */
export async function findTweetCandidates(
  poster: XPoster,
  accounts: string[],
  cache: Cache,
  minLikes: number,
): Promise<TweetCandidate[]> {
  const page = poster.getPage();
  if (!page) {
    logger.warn('[auto-engage] poster.getPage() が null です。poster.open() を先に呼んでください。');
    return [];
  }

  const candidates: TweetCandidate[] = [];

  for (const account of accounts) {
    try {
      logger.info(`[auto-engage] @${account} タイムライン確認中...`);
      await page.goto(`https://x.com/${account}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(() => {});
      await page.waitForTimeout(3000);

      const tweets = await page.locator('article[data-testid="tweet"]').all();
      const limit = Math.min(tweets.length, 6);

      for (let i = 0; i < limit; i++) {
        try {
          const tweet = tweets[i];

          // ── URL 取得 ──
          const anchor = tweet.locator('a[href*="/status/"]').first();
          const href = await anchor.getAttribute('href').catch(() => null);
          if (!href) continue;

          const tweetUrl = `https://x.com${href.split('?')[0]}`;
          if (cache.quoted[tweetUrl]) continue; // 引用済みスキップ

          // ── RT / リプライは除外（オリジナルのみ） ──
          const isSocial = await tweet.locator('[data-testid="socialContext"]')
            .isVisible({ timeout: 500 }).catch(() => false);
          if (isSocial) continue;

          // ── テキスト取得 ──
          const textEl = tweet.locator('[data-testid="tweetText"]').first();
          const text = (await textEl.textContent().catch(() => '')) ?? '';
          if (text.trim().length < 30) continue;

          // ── いいね数 取得 ──
          const likeEl = tweet.locator('[data-testid="like"] span').first();
          const likeText = (await likeEl.textContent().catch(() => '0')) ?? '0';
          const likes = parseLikeCount(likeText);
          if (likes < minLikes) continue;

          candidates.push({ url: tweetUrl, text: text.trim(), likes, account });
        } catch { /* 個別ツイートのエラーはスキップ */ }
      }

      await page.waitForTimeout(500);
    } catch (err) {
      logger.warn(
        `[auto-engage] @${account} スクレイプ失敗: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // いいね数の多い順にソート
  return candidates.sort((a, b) => b.likes - a.likes);
}

/**
 * Claude を使って引用コメントを生成（100文字以内・専門家目線・日本語）
 */
export async function generateQuoteComment(
  candidate: TweetCandidate,
  client: Anthropic,
): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `あなたは日本のAI/テック専門家です。以下のAI関連ツイートへの引用コメントを書いてください。

【元ツイート】（@${candidate.account}）
${candidate.text.slice(0, 500)}

【条件】
- 日本語で100文字以内
- 専門家目線の鋭い考察・補足・自分の視点を1〜2文
- 日本のビジネス・業界視点や実際の活用例を絡める
- 「すごい」「素晴らしい」などの陳腐な表現は避ける
- ハッシュタグ・URL不要（引用ツイートなので元のが表示される）
- コメント本文のみ出力（前置き・説明・引用符なし）`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return text.trim();
}

// ── メイン ──────────────────────────────────────────────────────────

export interface AutoEngageResult {
  quoted: number;
  skipped: number;
  candidates: number;
}

export async function runAutoEngage(
  poster: XPoster,
  anthropic: Anthropic,
  opts: {
    dryRun?: boolean;
    maxQuotes?: number;
    accounts?: string[];
    minLikes?: number;
  } = {},
): Promise<AutoEngageResult> {
  const {
    dryRun = false,
    maxQuotes = 1,
    accounts = TARGET_ACCOUNTS,
    minLikes = 100,
  } = opts;

  const cache = loadCache();
  purgeOldEntries(cache);

  let quoted = 0;
  let skipped = 0;

  // ── 候補収集 ──
  let candidates: TweetCandidate[];

  if (dryRun) {
    logger.info('[auto-engage] [DRY-RUN] ダミー候補を使用します');
    candidates = [
      {
        url: 'https://x.com/OpenAI/status/1234567890',
        text: 'Introducing our new model with breakthrough reasoning capabilities. Available now in ChatGPT.',
        likes: 12_000,
        account: 'OpenAI',
      },
    ];
  } else {
    candidates = await findTweetCandidates(poster, accounts, cache, minLikes);
  }

  logger.info(`[auto-engage] 候補: ${candidates.length}件 (likes ≥ ${minLikes})`);

  // ── 引用ループ ──
  for (const candidate of candidates) {
    if (quoted >= maxQuotes) break;

    logger.info(
      `[auto-engage] 引用候補: @${candidate.account} | likes=${candidate.likes} | ${candidate.url}`,
    );
    logger.info(`[auto-engage] テキスト（先頭100字）: ${candidate.text.slice(0, 100)}`);

    // コメント生成
    const comment = await generateQuoteComment(candidate, anthropic).catch((err) => {
      logger.warn(
        `[auto-engage] Claude 生成失敗: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });

    if (!comment) {
      skipped++;
      continue;
    }

    logger.info(`[auto-engage] 生成コメント: ${comment}`);

    // 引用ツイート投稿
    const success = await poster.quoteTweet(candidate.url, comment);

    if (success) {
      cache.quoted[candidate.url] = new Date().toISOString();
      saveCache(cache);
      quoted++;
      logger.info(`[auto-engage] ✅ 引用完了 (${quoted}/${maxQuotes})`);

      // 連続引用を避けるため30秒待機
      if (quoted < maxQuotes) {
        logger.info('[auto-engage] 次の引用まで30秒待機...');
        await new Promise((r) => setTimeout(r, 30_000));
      }
    } else {
      skipped++;
    }
  }

  if (candidates.length === 0) {
    logger.info(
      '[auto-engage] 候補ツイートが見つかりませんでした。' +
      '(likes 閾値が高すぎる / 引用済みキャッシュに全件ヒット / アカウントがスクレイプ不可)',
    );
  }

  logger.info(
    `[auto-engage] 完了 — 引用: ${quoted}件, スキップ: ${skipped}件, 候補: ${candidates.length}件`,
  );
  return { quoted, skipped, candidates: candidates.length };
}
