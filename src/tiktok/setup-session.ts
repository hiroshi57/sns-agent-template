/**
 * TikTok セッション初期設定スクリプト（自動ログイン）
 *
 * 使い方:
 *   npm run tiktok:setup
 *
 * .env の TIKTOK_USERNAME / TIKTOK_PASSWORD を使って自動ログインし、
 * state/tiktok-session.json にセッションを保存します。
 * CAPTCHA が出た場合はブラウザを手動で解決した後に Enter を押してください。
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { logger } from '../utils/logger';

const SESSION_FILE = path.join(process.cwd(), 'state', 'tiktok-session.json');

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
  const username = requireEnv('TIKTOK_USERNAME');
  const password = requireEnv('TIKTOK_PASSWORD');

  logger.info('TikTok セッション初期設定を開始します...');
  logger.info(`ユーザー名: ${username}`);

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ── Step 1: ログインページを開く ──
    logger.info('TikTok ログインページへ移動...');
    await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'logs/tiktok-setup-step1.png' }).catch(() => {});

    // ── Step 2: 「電話番号/メール/ユーザー名を使う」をクリック ──
    logger.info('「電話番号/メール/ユーザー名を使う」を探しています...');
    const step1Texts = [
      '電話番号/メール/ユーザー名',
      '電話番号',
      'Use phone / email / username',
      'Phone / Email / Username',
    ];
    let step1Done = false;
    for (const txt of step1Texts) {
      const el = page.locator(`:text("${txt}")`).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        await el.click();
        logger.info(`クリック: "${txt}"`);
        step1Done = true;
        await page.waitForTimeout(2000);
        break;
      }
    }
    if (!step1Done) logger.warn('ログイン方法選択ボタンが見つかりませんでした（スキップ）');
    await page.screenshot({ path: 'logs/tiktok-setup-step2.png' }).catch(() => {});

    // ── Step 3: 「メールアドレス/ユーザー名」タブへ切り替え ──
    const tabTexts = ['メールアドレス/ユーザー名', 'Email / Username', 'メール', 'Email'];
    for (const txt of tabTexts) {
      const el = page.locator(`:text("${txt}")`).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => '?');
        if (tag !== 'p' && tag !== 'h1' && tag !== 'h2') { // ラベルテキストは除外
          await el.click();
          logger.info(`タブ切り替え: "${txt}"`);
          await page.waitForTimeout(1500);
          break;
        }
      }
    }
    await page.screenshot({ path: 'logs/tiktok-setup-step3.png' }).catch(() => {});

    // ── Step 4: ユーザー名 / パスワード入力 ──
    logger.info('ユーザー名入力欄を検索...');
    const inputSelectors = [
      'input[name="username"]',
      'input[type="email"]',
      'input[type="text"]',
      'input[placeholder*="ユーザー名"]',
      'input[placeholder*="メール"]',
      'input[placeholder*="username"]',
      'input[placeholder*="email"]',
      'input[autocomplete="username"]',
    ];
    let emailInput = null;
    for (const sel of inputSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        emailInput = el;
        logger.info(`入力欄検出: ${sel}`);
        break;
      }
    }

    if (!emailInput) {
      // 自動入力に失敗 → CAPTCHA 等の可能性。手動でログインして Enter を押してもらう
      logger.warn('');
      logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.warn('  自動入力欄の検出に失敗しました（CAPTCHA の可能性）');
      logger.warn('  ブラウザで手動ログインしてください：');
      logger.warn(`  ユーザー名: ${username}`);
      logger.warn(`  パスワード: ${password}`);
      logger.warn('  ホーム画面が出たら Enter を押してください。');
      logger.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.warn('');
      await waitEnter('TikTok ホーム画面が表示されたら Enter: ');
    } else {
      // 自動入力
      await emailInput.fill(username);
      await page.waitForTimeout(400);

      const pwInput = page.locator('input[type="password"]').first();
      await pwInput.waitFor({ timeout: 10000 });
      await pwInput.fill(password);
      await page.waitForTimeout(400);

      // ── Step 5: ログインボタンを待って（enabled になるまで）クリック ──
      logger.info('ログインボタンを待機中...');
      // disabled が解除されるまで最大30秒待つ
      const loginBtnSel = 'button[data-e2e="login-button"], button[type="submit"]';
      const loginBtn = page.locator(loginBtnSel).first();
      await loginBtn.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
      // enabled になるまでポーリング（最大30秒）
      let enabled = false;
      for (let i = 0; i < 30; i++) {
        enabled = await loginBtn.isEnabled().catch(() => false);
        if (enabled) break;
        await page.waitForTimeout(1000);
      }

      if (enabled) {
        await loginBtn.click({ force: true });
        logger.info('ログインボタンクリック');
      } else {
        logger.warn('ログインボタンが有効になりませんでした。手動でログインしてください。');
      }

      logger.info('');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info('  CAPTCHA・SMS認証・2FA が表示された場合は');
      logger.info('  ブラウザで手動で完了してください。');
      logger.info('  時間制限はありません。');
      logger.info('  TikTok のホーム画面が表示されたら Enter を押してください。');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info('');
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'logs/tiktok-setup-step5.png' }).catch(() => {});
      await waitEnter('TikTok ホーム画面が表示されたら Enter: ');
    }

    // ── Step 6: ログイン確認 ──
    const isLoggedIn = await page.locator(
      '[data-e2e="upload-icon"], [data-e2e="nav-upload"], a[href*="/@"], [data-testid="upload-btn"]'
    ).first().isVisible({ timeout: 10000 }).catch(() => false);

    if (!isLoggedIn) {
      logger.warn('ログイン確認できませんでしたが、現状のセッションを保存します...');
    } else {
      logger.info('TikTok ログイン確認 OK');
    }

    // ── Step 7: セッション保存 ──
    await context.storageState({ path: SESSION_FILE });
    logger.info(`\n✅ セッション保存完了: ${SESSION_FILE}`);
    logger.info('次のコマンドで動作確認:  npm run tiktok:dry-run');

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
