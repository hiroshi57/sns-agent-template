/**
 * 下書き状態の note 記事を公開するスクリプト
 *
 * editor.note.com/notes/{id}/publish/ ページへ直接遷移して
 * 「無料で公開する」ボタンを押し、公開URLを取得する。
 *
 * 使い方:
 *   npm run note:publish-drafts
 */
import 'dotenv/config';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

const SESSION_FILE = path.join(process.cwd(), 'state', 'note-session.json');

const DRAFTS = [
  { key: 'headphone', publishUrl: 'https://editor.note.com/notes/ncc992a0daba2/publish/' },
  { key: 'pc',        publishUrl: 'https://editor.note.com/notes/nebb55a4b6ad5/publish/' },
  { key: 'monitor',   publishUrl: 'https://editor.note.com/notes/ne3d1d34e5d23/publish/' },
];

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

/** publish ページで「無料で公開する」ボタンを押して公開URLを返す */
async function publishDraft(page: Page, publishUrl: string, key: string): Promise<string | null> {
  logger.info(`[${key}] 公開設定ページへ移動: ${publishUrl}`);
  await page.goto(publishUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `logs/note-draft-${key}.png` }).catch(() => {});

  // 診断: ページ上のボタン一覧
  try {
    const btnDiag = await page.evaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
        return btns
          .filter(b => b.getBoundingClientRect().width > 0)
          .map(b => ({ text: (b.textContent || b.value || '').trim().substring(0, 60), disabled: !!b.disabled }));
      })()
    `) as Array<{ text: string; disabled: boolean }>;
    logger.info(`[${key}] ページのボタン: ${JSON.stringify(btnDiag)}`);
  } catch { /* ignore */ }

  // 「無料で公開する」「公開する」ボタンを探す（3回リトライ）
  let clicked = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const jsResult = await page.evaluate(`
      (() => {
        const candidates = Array.from(
          document.querySelectorAll('button, [role="button"], input[type="submit"]')
        );
        const priorities = ['投稿する', '無料で公開', '公開する', '公開', 'Publish'];
        for (const keyword of priorities) {
          // 後ろから探す（確認ダイアログの最終ボタン）
          const btn = [...candidates].reverse().find(el => {
            const text = (el.textContent || el.value || '').trim();
            return text.includes(keyword)
              && !el.disabled
              && el.getAttribute('aria-disabled') !== 'true'
              && el.getBoundingClientRect().width > 0;
          });
          if (btn) { btn.click(); return (btn.textContent || btn.value || '').trim(); }
        }
        return null;
      })()
    `) as string | null;

    if (jsResult) {
      logger.info(`[${key}] 公開ボタンクリック (JS, 試行${attempt}): "${jsResult}"`);
      clicked = true;
      break;
    }

    // Playwright フォールバック
    const locators = [
      page.locator('button').filter({ hasText: '投稿する' }).last(),
      page.locator('button').filter({ hasText: '無料で公開する' }).last(),
      page.locator('button').filter({ hasText: '公開する' }).last(),
      page.locator('button').filter({ hasText: '公開' }).last(),
    ];
    for (const loc of locators) {
      if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click();
        logger.info(`[${key}] 公開ボタンクリック（Playwright, 試行${attempt}）`);
        clicked = true;
        break;
      }
    }
    if (clicked) break;

    logger.warn(`[${key}] 公開ボタン未検出 (試行${attempt}/3)。2秒後に再試行...`);
    await page.waitForTimeout(2000);
  }

  if (!clicked) {
    await page.screenshot({ path: `logs/note-draft-${key}-fail.png` }).catch(() => {});
    logger.error(`[${key}] 公開ボタンが見つかりません`);
    return null;
  }

  // 公開後URL取得
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `logs/note-draft-${key}-after.png` }).catch(() => {});

  // Try 1: ページ内の公開記事リンクを探す
  const foundUrl = await page.evaluate(`
    (() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const link = links.find(a => {
        const href = a.href || '';
        return /note\\.com\\/[^/]+\\/n\\/[a-z0-9]+/.test(href) && !href.includes('editor.note.com');
      });
      return link ? link.href : null;
    })()
  `) as string | null;

  if (foundUrl) {
    logger.info(`[${key}] ✅ 公開URL（ページリンク）: ${foundUrl}`);
    return foundUrl;
  }

  // Try 2: note.com/n/{id} にナビゲートしてリダイレクトURLを取得
  const editorUrl = page.url();
  const noteIdMatch = editorUrl.match(/\/notes\/([a-z0-9]+)/);
  if (noteIdMatch) {
    const noteSlug = noteIdMatch[1];
    try {
      await page.goto(`https://note.com/n/${noteSlug}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      const redirectedUrl = page.url();
      logger.info(`[${key}] ✅ 公開URL（リダイレクト）: ${redirectedUrl}`);
      return redirectedUrl;
    } catch {
      logger.warn(`[${key}] リダイレクト取得失敗`);
    }
  }

  logger.warn(`[${key}] URLが取得できませんでした。現在URL: ${page.url()}`);
  return page.url();
}

async function main(): Promise<void> {
  logger.info('=== Note 下書き記事 公開スクリプト ===');

  if (!fs.existsSync(SESSION_FILE)) {
    logger.error(`セッションファイルが見つかりません: ${SESSION_FILE}`);
    logger.info('npm run note:setup でセッションを作成してください。');
    process.exit(1);
  }

  const isCI = process.env['CI'] === 'true';
  const browser: Browser = await chromium.launch({
    headless: isCI,
    args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
  });
  const context: BrowserContext = await browser.newContext({ storageState: SESSION_FILE });
  const page: Page = await context.newPage();

  fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

  try {
    // ログイン確認
    await page.goto('https://note.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const isLoggedIn = await page.locator(
      'a[href*="/notes/new"], button:has-text("投稿"), a[href*="/settings"]'
    ).first().isVisible({ timeout: 8000 }).catch(() => false);

    if (!isLoggedIn) {
      logger.error('note セッションが期限切れです。npm run note:setup を実行してください。');
      process.exit(1);
    }
    logger.info('note ログイン確認 OK');

    const results: Record<string, string | null> = {};

    for (const draft of DRAFTS) {
      logger.info(`\n${'─'.repeat(60)}`);
      const url = await publishDraft(page, draft.publishUrl, draft.key);
      results[draft.key] = url;

      if (draft !== DRAFTS[DRAFTS.length - 1]) {
        logger.info('次の記事まで5秒待機...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    logger.info(`\n${'='.repeat(60)}`);
    logger.info('=== 公開結果 ===');
    for (const [key, url] of Object.entries(results)) {
      logger.info(`  ${key}: ${url ?? '❌ 失敗'}`);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch(err => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
