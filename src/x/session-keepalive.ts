/**
 * X.com セッション維持スクリプト（毎日自動実行）
 *
 * 目的:
 *   - 既存セッション(state/x-session.json)を使って X.com にアクセスし
 *     Cookie の有効期限を自動更新する
 *   - セッションが切れていた場合は即座に失敗し、手動 x:setup を促す
 *   - 「自動ログインのレート制限」を根本的に防ぐ
 *
 * 使い方:
 *   npm run x:keepalive          # 手動実行
 *   PM2 cron で毎朝 06:00 に自動実行（ecosystem.config.js 参照）
 *
 * 終了コード:
 *   0 = セッション有効・更新成功
 *   1 = セッション失効 → npm run x:setup を実行してください
 *   2 = X.com レート制限（15〜30 分後に自動解除）
 *   3 = アカウント凍結・制限 → 手動確認が必要
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const SESSION_FILE = path.join(process.cwd(), 'state', 'x-session.json');

async function main(): Promise<void> {
  logger.info('=== X.com セッション維持チェック ===');

  // ── セッションファイルの存在確認 ──
  if (!fs.existsSync(SESSION_FILE)) {
    logger.error('state/x-session.json が見つかりません。');
    logger.error('👉 npm run x:setup を実行して初回セッションを作成してください。');
    process.exit(1);
  }

  // ── 認証 Cookie の存在確認（ブラウザ起動前の軽量チェック）──
  try {
    const sess = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    const authCookies = (sess.cookies ?? []).filter(
      (c: { name: string }) => ['auth_token', 'ct0', 'twid'].includes(c.name)
    );
    if (authCookies.length === 0) {
      logger.error('セッションに認証 Cookie がありません（未ログイン状態）。');
      logger.error('👉 npm run x:setup を実行してログインし直してください。');
      process.exit(1);
    }
    logger.info(`認証 Cookie 確認: ${authCookies.map((c: { name: string }) => c.name).join(', ')}`);
  } catch {
    logger.error('セッションファイルの読み込みに失敗しました。');
    logger.error('👉 npm run x:setup を実行してください。');
    process.exit(1);
  }

  // ── ブラウザでセッション有効性を確認・更新 ──
  const isCI = process.env['CI'] === 'true';
  const browser = await chromium.launch({
    headless: isCI,
    args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
  });

  try {
    const context = await browser.newContext({ storageState: SESSION_FILE });
    const page = await context.newPage();

    logger.info('X.com にアクセス中...');
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // SideNav でログイン済み確認
    const hasSideNav = await page.locator('[data-testid="SideNav_NewTweet_Button"]')
      .isVisible({ timeout: 8000 }).catch(() => false);

    if (!hasSideNav) {
      await page.screenshot({ path: 'logs/x-keepalive-expired.png' }).catch(() => {});
      const pageText = await page.textContent('body').catch(() => '') || '';
      const currentUrl = page.url();

      // ── アカウント凍結・制限の検出 ──
      const isSuspended =
        currentUrl.includes('account/suspended') ||
        currentUrl.includes('account_suspended') ||
        pageText.includes('アカウントが凍結') ||
        pageText.toLowerCase().includes('account has been suspended') ||
        pageText.toLowerCase().includes('account is suspended');

      if (isSuspended) {
        logger.error('❌ X アカウントが凍結または制限されています！');
        logger.error('   手動確認: https://x.com/i/flow/login');
        logger.error('   スクリーンショット: logs/x-keepalive-expired.png');
        process.exit(3);
      }

      // ── レート制限の検出 ──
      const isRateLimited =
        pageText.includes('一時的に制限') ||
        pageText.includes('too many requests') ||
        pageText.toLowerCase().includes('temporarily locked') ||
        pageText.toLowerCase().includes('rate limit') ||
        currentUrl.includes('flow/unlock');

      if (isRateLimited) {
        logger.warn('⚠️  X.com レート制限を検出しました。15〜30 分後に自動解除されます。');
        logger.warn('   次回の keepalive で自動リカバリーします。');
        logger.warn('   スクリーンショット: logs/x-keepalive-expired.png');
        process.exit(2);
      }

      // ── 通常のセッション失効 ──
      const isCI = process.env['CI'] === 'true';
      logger.error('X セッションが失効しています。');
      if (isCI) {
        logger.error('');
        logger.error('=== GitHub Actions でのセッション更新方法 ===');
        logger.error('  1. ローカルで: npm run x:setup');
        logger.error('  2. state/x-session.json の内容をコピー');
        logger.error('  3. GitHub → Settings → Secrets → X_SESSION_JSON を更新');
        logger.error('  4. x-session-refresh ワークフローを手動実行');
        logger.error('==============================================');
      } else {
        logger.error('👉 npm run x:setup を実行してログインし直してください。');
      }
      logger.error('   スクリーンショット: logs/x-keepalive-expired.png');
      process.exit(1);
    }

    // Cookie を更新して保存
    await context.storageState({ path: SESSION_FILE });
    logger.info('✅ セッション有効・Cookie 更新完了');

    // 保存した Cookie の auth_token 有効期限を表示
    try {
      const updated = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      const authToken = (updated.cookies ?? []).find((c: { name: string; expires?: number }) => c.name === 'auth_token');
      if (authToken?.expires && authToken.expires > 0) {
        const exp = new Date(authToken.expires * 1000);
        logger.info(`auth_token 有効期限: ${exp.toLocaleDateString('ja-JP')} ${exp.toLocaleTimeString('ja-JP')}`);
      }
    } catch { /* 無視 */ }

    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }

  logger.info('=== keepalive 完了 ===');
  process.exit(0);
}

main().catch((err) => {
  logger.error(`keepalive エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
