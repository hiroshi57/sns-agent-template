/**
 * Instagram セッション keepalive
 *
 * Instagram にアクセスしてセッションを更新するだけのスクリプト。
 * 週1回程度実行してセッション期限切れを防ぐ。
 *
 * pm2 cron: '0 2 * * 0'  （毎週日曜 11:00 JST = UTC 02:00）
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const SESSION_FILE = path.join(process.cwd(), 'state', 'instagram-session.json');

async function keepalive(): Promise<void> {
  if (!fs.existsSync(SESSION_FILE)) {
    logger.warn('[Instagram keepalive] セッションファイルが存在しません。npm run instagram:setup を実行してください。');
    return;
  }

  const isCI = process.env['CI'] === 'true';
  const browser = await chromium.launch({
    // headless: false で Instagram の bot 検出を回避
    headless: isCI,
    args: [
      ...(isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const context = await browser.newContext({
      storageState: SESSION_FILE,
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    logger.info('[Instagram keepalive] instagram.com にアクセス中...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);

    // ログイン確認
    const isLoggedIn = await page.locator(
      'svg[aria-label="新規投稿"], svg[aria-label="New post"], ' +
      'svg[aria-label="作成"], svg[aria-label="Create"], ' +
      'a[href*="/direct/"], [aria-label="ホーム"], [aria-label="Home"]'
    ).first().isVisible({ timeout: 15000 }).catch(() => false);

    if (isLoggedIn) {
      await context.storageState({ path: SESSION_FILE });
      logger.info('[Instagram keepalive] ✅ セッション更新完了');
    } else {
      logger.warn('[Instagram keepalive] ⚠️ セッションが期限切れです。npm run instagram:setup でログインし直してください。');
      await page.screenshot({ path: 'logs/instagram-keepalive-expired.png' }).catch(() => {});
    }

    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }
}

keepalive().catch(err => {
  logger.error(`[Instagram keepalive] エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
