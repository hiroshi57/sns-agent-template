/**
 * note セッション初期化スクリプト
 *
 * headful ブラウザで note にログインし、
 * state/note-session.json にセッションを保存する。
 *
 * 使い方: npm run note:setup
 *
 * CAPTCHA・SMS認証・2FA が出た場合は手動で解決してください。
 * ホーム画面が表示されたら Enter を押すとセッションが保存されます。
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { logger } from '../utils/logger';

const SESSION_FILE = path.join(process.cwd(), 'state', 'note-session.json');

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) { logger.error(`環境変数 ${key} が .env に設定されていません`); process.exit(1); }
  return val!;
}

async function waitEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>(r => { rl.question(prompt, () => { rl.close(); r(); }); });
}

async function main() {
  const email = requireEnv('NOTE_EMAIL');
  const password = requireEnv('NOTE_PASSWORD');

  logger.info('note セッション初期設定を開始します...');
  logger.info(`メール: ${email}`);

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ── Step 1: ログインページを開く ──
    logger.info('note ログインページへ移動...');
    await page.goto('https://note.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'logs/note-setup-step1.png' }).catch(() => {});

    // ── Step 2: 自動ログインを試みる ──
    const emailInput = page.locator('input[name="email"], input[type="email"]').first();
    if (await emailInput.isVisible({ timeout: 8000 }).catch(() => false)) {
      await emailInput.fill(email);
      await page.waitForTimeout(400);

      const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
      if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await passwordInput.fill(password);
        await page.waitForTimeout(400);
      }

      const loginBtn = page.locator('button[type="submit"], button:has-text("ログイン")').first();
      if (await loginBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await loginBtn.click();
        logger.info('ログインボタンをクリックしました');
      }
    } else {
      logger.warn('入力欄が見つかりません。手動でログインしてください。');
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'logs/note-setup-step2.png' }).catch(() => {});

    // ── Step 3: 手動対応を待つ（CAPTCHA・認証コード等）──
    logger.info('');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('  CAPTCHA・SMS認証・2FA が表示された場合は');
    logger.info('  ブラウザで手動で完了してください。');
    logger.info('  時間制限はありません。');
    logger.info(`  ログイン情報: ${email} / ${password}`);
    logger.info('  note のホーム画面が表示されたら');
    logger.info('  ここで Enter キーを押してください。');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('');
    await waitEnter('note ホーム画面が表示されたら Enter を押してください: ');

    // ── Step 4: ログイン確認 ──
    await page.screenshot({ path: 'logs/note-setup-step3.png' }).catch(() => {});
    const isLoggedIn = await page.locator(
      'a[href*="/notes/new"], [data-cy="header-post-button"], ' +
      'button:has-text("投稿"), a[href*="/settings"], ' +
      '[data-testid="post-button"]'
    ).first().isVisible({ timeout: 8000 }).catch(() => false);

    if (!isLoggedIn) {
      logger.warn('ログイン確認できませんでしたが、現状のセッションを保存します...');
    } else {
      logger.info('note ログイン確認 OK');
    }

    // ── Step 5: セッション保存 ──
    await context.storageState({ path: SESSION_FILE });
    logger.info(`\n✅ セッション保存完了: ${SESSION_FILE}`);
    logger.info('次のコマンドで動作確認:  npm run note:dry-run');

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
