/**
 * 全スロットを1つのブラウザセッションで順番に一括投稿するスクリプト
 *
 * 使い方:
 *   npm run x:all
 *
 * スロットスケジュール（平日のみ）:
 *   07:00 slot07 — 4件通常 + 1件ネタ系
 *   11:00 slot11 — 4件通常 + 1件ネタ系 + 1件アフィリエイトランキング（1日1回）
 *   13:00 slot12 — 4件通常 + 1件ネタ系
 *   16:00 slot14 — 4件通常 + 1件ネタ系
 *   18:00 slot17 — 4件通常 + 1件ネタ系
 *   合計: 26件/日（5スロット×5件 + アフィリエイト1件）
 *
 * - ブラウザは1回だけ起動し、全スロット共有（ログイン制限を最小化）
 * - 各スロット前に目標時刻まで待機（時刻過ぎていたら即実行）
 * - レート制限検出時は30分待機して自動リトライ（X.com の制限解除を待つ）
 * - 1スロット後に気休めネタを1件投稿
 * - slot11 完了後にアフィリエイトランキング TOP3 を1投稿（data/affiliate-products.json 参照）
 */
import 'dotenv/config';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { XPoster } from '../x/poster';
import { runSlot } from '../index-x';
import { postReliefItems } from '../x/post-relief';
import { postAffiliateRanking } from '../x/post-affiliate-ranking';
import { SlotName, SLOT_TARGET_HOUR } from '../utils/x-category';
import { isJapaneseHoliday } from '../utils/holiday';
import { logger } from '../utils/logger';

const SLOTS: SlotName[] = ['slot07', 'slot11', 'slot12', 'slot14', 'slot17'];
/** X.com レート制限時の待機時間: 30分（制限は15〜30分） */
const RATE_LIMIT_WAIT_MS = 30 * 60 * 1000;
/** 一般的な失敗時のリトライ間隔: 5分 */
const GENERAL_RETRY_MS = 5 * 60 * 1000;
/** ログイン最大リトライ回数: これを超えたら手動対応を促して終了 */
const MAX_LOGIN_RETRIES = 3;

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

/**
 * JST の目標時刻（hour:minute）まで待機する。
 * すでに過ぎていた場合は即リターン。
 */
async function waitUntilJstTime(hour: number, minute: number, slotName: string): Promise<void> {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9
  const target = new Date(jstNow);
  target.setUTCHours(hour - 9, minute, 0, 0); // JST hour → UTC hour

  const waitMs = target.getTime() - now.getTime();
  if (waitMs <= 0) {
    logger.info(`[${slotName}] 目標時刻 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} JST はすでに経過 → 即実行`);
    return;
  }

  const targetLocal = target.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  logger.info(`[${slotName}] ${targetLocal} JST まで待機中... (${Math.ceil(waitMs / 60000)}分後)`);
  await waitWithCountdown(waitMs, `[${slotName}] 目標時刻まで待機`);
}

/** waitMs ミリ秒待機しながら、1分ごとに残り時間をログ出力する */
async function waitWithCountdown(waitMs: number, reason: string): Promise<void> {
  const retryAt = new Date(Date.now() + waitMs);
  logger.warn(`${reason} — ${waitMs / 60000}分後 (${retryAt.toLocaleTimeString('ja-JP')}) に自動リトライします。このままお待ちください...`);

  const intervalMs = 60 * 1000; // 1分ごとに残り時間を表示
  let remaining = waitMs;
  while (remaining > 0) {
    await new Promise(r => setTimeout(r, Math.min(intervalMs, remaining)));
    remaining -= intervalMs;
    if (remaining > 0) {
      logger.info(`⏳ リトライまで残り ${Math.ceil(remaining / 60000)}分...`);
    }
  }
}

async function main() {
  // ── 平日チェック（土日・祝日はスキップ）──
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const jstDay = nowJst.getUTCDay(); // 0=日, 6=土
  if (jstDay === 0 || jstDay === 6) {
    logger.info(`本日は${jstDay === 0 ? '日曜' : '土曜'}のため X 投稿をスキップします。`);
    process.exit(0);
  }
  if (isJapaneseHoliday(new Date())) {
    logger.info('本日は祝日のため X 投稿をスキップします。');
    process.exit(0);
  }

  logger.info('=== 全スロット一括投稿モード（ブラウザ共有）===');
  logger.info(`対象スロット: ${SLOTS.join(', ')}`);
  logger.info('Ctrl+C で停止\n');

  const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

  const xPoster = new XPoster({
    email: requireEnv('X_EMAIL'),
    password: requireEnv('X_PASSWORD'),
    username: process.env['X_USERNAME'],
    phone: process.env['X_PHONE'],
  });

  // ── セッション事前チェック（認証 Cookie の存在確認）──
  const SESSION_FILE = path.join(process.cwd(), 'state', 'x-session.json');
  if (require('fs').existsSync(SESSION_FILE)) {
    try {
      const sess = JSON.parse(require('fs').readFileSync(SESSION_FILE, 'utf-8'));
      const authCookies = (sess.cookies ?? []).filter(
        (c: { name: string }) => ['auth_token', 'ct0', 'twid'].includes(c.name)
      );
      if (authCookies.length === 0) {
        logger.error('');
        logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        logger.error('  ⚠️  X.com セッションが未ログイン状態です');
        logger.error('  以下を実行してからもう一度試してください:');
        logger.error('');
        logger.error('    npm run x:setup');
        logger.error('    npm run x:keepalive  ← 毎日実行してセッションを維持');
        logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        logger.error('');
        process.exit(1);
      }
    } catch { /* 読み込み失敗は open() に任せる */ }
  }

  // ブラウザ起動 & ログイン（失敗時はリトライ、最大 MAX_LOGIN_RETRIES 回）
  let loginAttempt = 1;
  while (true) {
    logger.info(`ブラウザ起動試行 ${loginAttempt}/${MAX_LOGIN_RETRIES} — ${new Date().toLocaleTimeString('ja-JP')}`);
    const opened = await xPoster.open();
    if (opened) break;

    if (loginAttempt >= MAX_LOGIN_RETRIES) {
      logger.error('');
      logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.error(`  ⚠️  ログインに ${MAX_LOGIN_RETRIES} 回失敗しました`);
      logger.error('  X.com のレート制限が長引いています。');
      logger.error('  手動でセッションを更新してください:');
      logger.error('');
      logger.error('    npm run x:setup    ← ブラウザで手動ログイン');
      logger.error('    npm run x:all      ← その後に再実行');
      logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.error('');
      process.exit(1);
    }

    // レート制限なら30分、それ以外なら5分待機
    if (xPoster.lastFailureWasRateLimit) {
      await waitWithCountdown(RATE_LIMIT_WAIT_MS, 'X.com レート制限を検出');
    } else {
      await waitWithCountdown(GENERAL_RETRY_MS, 'ログイン失敗');
    }
    loginAttempt++;
  }

  logger.info('ブラウザ起動成功。全スロット投稿を開始します。\n');

  const results: Record<string, { success: number; error: number }> = {};

  try {
    for (const slot of SLOTS) {
      // ── 目標時刻まで待機 ──
      const { hour, minute } = SLOT_TARGET_HOUR[slot];
      await waitUntilJstTime(hour, minute, slot);

      logger.info(`\n${'='.repeat(60)}`);
      logger.info(`[${slot}] 開始 (目標 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} JST)`);

      // ── 通常記事 4件投稿 ──
      let slotAttempt = 1;
      while (true) {
        try {
          await runSlot(slot, { force: true, xPoster });
          results[slot] = results[slot] ?? { success: 1, error: 0 };
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('一時的に制限') || msg.includes('temporarily locked') || msg.includes('Too many') || msg.includes('ログイン制限')) {
            await waitWithCountdown(RATE_LIMIT_WAIT_MS, `[${slot}] レート制限 (試行 ${slotAttempt})`);
            slotAttempt++;
          } else {
            logger.error(`[${slot}] エラー: ${msg}`);
            results[slot] = { success: 0, error: 1 };
            break;
          }
        }
      }

      // ── ネタ系 1件投稿（スロットごとに実行）──
      logger.info(`\n--- [${slot}] ネタ系 1件投稿 ---`);
      await postReliefItems(xPoster, anthropic, 1).catch(err => {
        logger.warn(`[${slot}] ネタ系投稿エラー（スキップ）: ${err instanceof Error ? err.message : String(err)}`);
      });

      // ── アフィリエイトランキング投稿（slot11 完了後に1日1回）──
      // 通常の AI ニュース投稿・ネタ系投稿は一切変更せず、追加で実行する
      if (slot === 'slot11') {
        logger.info(`\n--- [${slot}] アフィリエイトランキング投稿 ---`);
        await postAffiliateRanking(xPoster, anthropic, {
          dryRun: process.env['DRY_RUN'] === 'true',
          topN: 3,
        }).catch(err => {
          logger.warn(`[${slot}] アフィリエイトランキング投稿エラー（スキップ）: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  } finally {
    await xPoster.close();
  }

  logger.info('\n=== 全スロット完了（5スロット×5件 + アフィリエイト1件 = 26件/日） ===');
  for (const [slot, res] of Object.entries(results)) {
    logger.info(`  ${slot}: 成功 ${res.success} / エラー ${res.error}`);
  }
}

main().catch(err => {
  logger.error(`エラー: ${err}`);
  process.exit(1);
});
