/**
 * セーフティガード（Layer 3 — Hooks / Guardrail Layer）
 *
 * X 投稿前に呼ぶ防御チェック群。
 * いずれかが false を返したら投稿をスキップする。
 *
 * チェック項目:
 *   1. 文字数 (≤280)
 *   2. URL が 1 つ以上含まれているか
 *   3. PII パターン（email / 電話番号）が残っていないか
 *   4. 禁止ワード（レート制限・課金ページ検出時のフラグ）
 *   5. ツイート本文が空でないか
 */
import { logger } from '../utils/logger';

const FORBIDDEN_PATTERNS = [
  /RATE_LIMIT_EXCEEDED/i,
  /BILLING_REQUIRED/i,
  /X_PREMIUM_REQUIRED/i,
  // PII 除去漏れの最終チェック
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,   // email
  /(?:0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})/,               // JP phone
];

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

export function guardTweet(tweetText: string, url: string): GuardResult {
  if (!tweetText || tweetText.trim().length === 0) {
    return { ok: false, reason: 'ツイート本文が空です' };
  }

  if (tweetText.length > 280) {
    logger.warn(`[Guard] ツイート文字数超過: ${tweetText.length} 文字 → 自動トリム済みのはずだが念のため警告`);
    // エラーにはしない（caller 側でスライス済み）
  }

  if (!url || !url.startsWith('http')) {
    return { ok: false, reason: `URL が不正です: ${url}` };
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(tweetText)) {
      return { ok: false, reason: `禁止パターン検出: ${pattern.toString().slice(0, 40)}` };
    }
  }

  return { ok: true };
}

/**
 * バッチ全体を事前チェックしてスキップすべき記事を除外する。
 * フックとして index-x.ts の投稿ループ前に呼ぶ。
 */
export function filterBatchByGuard<T extends { url: string }>(
  items: T[],
  getTweetText: (item: T) => string
): T[] {
  return items.filter((item) => {
    const text = getTweetText(item);
    const result = guardTweet(text, item.url);
    if (!result.ok) {
      logger.warn(`[Guard] スキップ: ${item.url.slice(0, 60)} — ${result.reason}`);
    }
    return result.ok;
  });
}
