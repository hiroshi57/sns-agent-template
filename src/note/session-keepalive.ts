/**
 * note セッション keepalive
 *
 * note.com にアクセスしてセッションを更新するだけのスクリプト。
 * 週1回程度実行してセッション期限切れを防ぐ。
 *
 * pm2 cron: '0 2 * * 0'  （毎週日曜 11:00 JST = UTC 02:00）
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const SESSION_FILE = path.join(process.cwd(), 'state', 'note-session.json');

async function keepalive(): Promise<void> {
  if (!fs.existsSync(SESSION_FILE)) {
    logger.warn('[note keepalive] セッションファイルが存在しません。npm run note:setup を実行してください。');
    return;
  }

  const isCI = process.env['CI'] === 'true';
  const browser = await chromium.launch({
    headless: isCI,
    args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
  });

  try {
    const context = await browser.newContext({ storageState: SESSION_FILE });
    const page = await context.newPage();

    logger.info('[note keepalive] note.com にアクセス中...');
    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // ログイン確認
    const isLoggedIn = await page.locator(
      'a[href*="/notes/new"], [data-cy="header-post-button"], ' +
      'button:has-text("投稿する"), a[href*="/settings"]'
    ).first().isVisible({ timeout: 10000 }).catch(() => false);

    if (isLoggedIn) {
      // セッションを保存して有効期限を延長
      await context.storageState({ path: SESSION_FILE });
      logger.info('[note keepalive] ✅ セッション更新完了');
    } else {
      logger.warn('[note keepalive] ⚠️ セッションが期限切れです。npm run note:setup でログインし直してください。');
      await page.screenshot({ path: 'logs/note-keepalive-expired.png' }).catch(() => {});
    }

    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }
}

keepalive().catch(err => {
  logger.error(`[note keepalive] エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
