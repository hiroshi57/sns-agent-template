/**
 * Instagram セッション初期化スクリプト
 *
 * headful ブラウザで Instagram にログインし、
 * state/instagram-session.json にセッションを保存する。
 *
 * 使い方: npm run instagram:setup
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

const SESSION_FILE = path.join(process.cwd(), 'state', 'instagram-session.json');

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
  const username = requireEnv('INSTAGRAM_USERNAME');
  const password = requireEnv('INSTAGRAM_PASSWORD');

  logger.info('Instagram セッション初期設定を開始します...');
  logger.info(`ユーザー名: ${username}`);

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ── Step 1: ログインページを開く ──
    logger.info('Instagram ログインページへ移動...');
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'logs/instagram-setup-step1.png' }).catch(() => {});

    // ── Step 2: ユーザー名・パスワード入力 ──
    const usernameInput = page.locator('input[name="username"]').first();
    if (await usernameInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      await usernameInput.fill(username);
      await page.waitForTimeout(400);

      const passwordInput = page.locator('input[name="password"]').first();
      await passwordInput.fill(password);
      await page.waitForTimeout(400);

      // ── Step 3: ログインボタンをクリック ──
      const loginBtn = page.locator('button[type="submit"]').first();
      if (await loginBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await loginBtn.click();
        logger.info('ログインボタンをクリックしました');
      } else {
        logger.warn('ログインボタンが見つかりません。手動でログインしてください。');
      }
    } else {
      logger.warn('入力欄が見つかりません。手動でログインしてください。');
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'logs/instagram-setup-step2.png' }).catch(() => {});

    // ── Step 4: CAPTCHA・認証コード・2FA の手動対応を待つ ──
    logger.info('');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('  CAPTCHA・SMS認証・2FA が表示された場合は');
    logger.info('  ブラウザで手動で完了してください。');
    logger.info('  時間制限はありません。');
    logger.info('  Instagram のホーム画面が表示されたら');
    logger.info('  ここで Enter キーを押してください。');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('');
    await waitEnter('ホーム画面が表示されたら Enter を押してください: ');

    // ── Step 5: ログイン確認 ──
    await page.screenshot({ path: 'logs/instagram-setup-step3.png' }).catch(() => {});
    const isLoggedIn = await page.locator(
      'svg[aria-label="新規投稿"], svg[aria-label="New post"], ' +
      'a[href*="/direct/"], [aria-label="ホーム"], [aria-label="Home"]'
    ).first().isVisible({ timeout: 8000 }).catch(() => false);

    if (!isLoggedIn) {
      logger.warn('ログイン確認できませんでしたが、現状のセッションを保存します...');
    } else {
      logger.info('Instagram ログイン確認 OK');
    }

    // 「ログイン情報を保存しますか？」ダイアログを閉じる
    const notNowBtn = page.locator('button:has-text("後で"), button:has-text("Not Now")').first();
    if (await notNowBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await notNowBtn.click();
      await page.waitForTimeout(1500);
    }

    // ── Step 6: セッション保存 ──
    await context.storageState({ path: SESSION_FILE });
    logger.info(`\n✅ セッション保存完了: ${SESSION_FILE}`);
    logger.info('次のコマンドで動作確認:  npm run instagram:dry-run');

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
