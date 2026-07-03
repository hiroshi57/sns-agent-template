/**
 * 既存の Note SEO 記事を編集・上書き公開するスクリプト
 *
 * - 既存記事の editor URL に直接アクセスして内容を更新
 * - アフィリエイトリンクを <a> タグ付きで注入
 * - 使い方: npm run note:edit-seo
 */
import 'dotenv/config';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { markdownToNote } from '../utils/markdown-to-note';
import { logger } from '../utils/logger';

const SESSION_FILE = path.join(process.cwd(), 'state', 'note-session.json');
const CREATOR_ID = 'modern_yarrow516';

const ARTICLES = [
  {
    key: 'headphone',
    noteId: 'ncc992a0daba2',
    file: 'docs/seo-content/note-headphone-review.md',
  },
  {
    key: 'pc',
    noteId: 'nebb55a4b6ad5',
    file: 'docs/seo-content/note-pc-macbook-gift.md',
  },
  {
    key: 'monitor',
    noteId: 'ne3d1d34e5d23',
    file: 'docs/seo-content/note-monitor-guide.md',
  },
];

/** テキスト内のアフィリエイトURLを <a> タグに変換した HTML を生成 */
function bodyToHtml(body: string): string {
  // 行ごとに処理
  const lines = body.split('\n').map(line => {
    // 👉 URL → <a href="URL">URL</a>
    line = line.replace(
      /👉\s*(https?:\/\/[^\s]+)/g,
      '👉 <a href="$1">こちらから購入・確認できます</a>'
    );
    // 残った裸の URL もリンク化
    line = line.replace(
      /(?<!href="|">)(https?:\/\/[^\s<"]+)/g,
      '<a href="$1">$1</a>'
    );
    return line;
  });
  return lines.join('\n');
}

/** ProseMirror エディタ内の URL テキストをリンクに変換 */
async function injectLinksIntoProseMirror(page: Page): Promise<void> {
  const result = await page.evaluate(`
    (() => {
      const editor = document.querySelector('.ProseMirror');
      if (!editor) return 'no editor';

      const urlRegex = /https?:\\/\\/[^\\s\\u3000-\\uffff]+/g;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      const found = [];

      let node;
      while ((node = walker.nextNode())) {
        urlRegex.lastIndex = 0;
        let match;
        while ((match = urlRegex.exec(node.textContent || '')) !== null) {
          // node が既に <a> の中にある場合はスキップ
          if (node.parentElement && node.parentElement.closest('a')) continue;
          found.push({ node, start: match.index, end: match.index + match[0].length, url: match[0].replace(/[).,]+$/, '') });
        }
      }

      // 後ろから処理（インデックスがずれないよう）
      let count = 0;
      for (const item of found.reverse()) {
        try {
          const range = document.createRange();
          range.setStart(item.node, item.start);
          range.setEnd(item.node, item.end);
          const sel = window.getSelection();
          if (!sel) continue;
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('createLink', false, item.url);
          count++;
        } catch (e) { /* ignore */ }
      }
      window.getSelection()?.removeAllRanges();
      return 'links created: ' + count;
    })()
  `) as string;
  logger.info(`[note] リンク注入: ${result}`);
}

async function editArticle(page: Page, noteId: string, title: string, body: string, key: string): Promise<string | null> {
  // ステップ A: note.com の記事ページから「公開設定」リンクをクリック
  //   → editor.note.com/notes/{id}/publish へ（認証付き）
  const publicUrl = `https://note.com/${CREATOR_ID}/n/${noteId}`;
  logger.info(`[${key}] 記事ページへ移動: ${publicUrl}`);
  await page.goto(publicUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 「公開設定」リンクをクリック（editor.note.com へ認証付きで遷移）
  const publishSettingsLink = page.locator(`a[href*="editor.note.com/notes/${noteId}"]`).first();
  if (await publishSettingsLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await publishSettingsLink.click();
    logger.info(`[${key}] 「公開設定」クリック → editor.note.com へ遷移`);
  } else {
    // フォールバック: 直接 /publish/ へ
    logger.warn(`[${key}] 公開設定リンク未検出 → 直接アクセス`);
    await page.goto(`https://editor.note.com/notes/${noteId}/publish`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
  }

  // /publish/ ページへ到達するまで待機
  try {
    await page.waitForURL(/editor\.note\.com\/notes\/.+\/publish/, { timeout: 15000 });
    logger.info(`[${key}] publish ページ到達: ${page.url()}`);
  } catch {
    logger.warn(`[${key}] publish ページ待機タイムアウト: ${page.url()}`);
  }
  await page.waitForTimeout(2000);

  // ステップ B: publish ページで「キャンセル」→ テキストエディタへ戻る
  const cancelClicked = await page.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const btn = btns.find(b => (b.textContent || '').trim() === 'キャンセル');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `) as boolean;
  logger.info(`[${key}] キャンセルクリック: ${cancelClicked}`);

  // テキストエディタへの遷移を待つ（/publish/ が消える）
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `logs/note-edit-${key}-open.png` }).catch(() => {});
  logger.info(`[${key}] エディタ現在URL: ${page.url()}`);

  // エディタ起動確認
  await page.waitForSelector('[contenteditable], textarea', { timeout: 20000 }).catch(() => {
    logger.warn(`[${key}] エディタ起動タイムアウト`);
  });
  await page.waitForTimeout(2000);

  // ---- タイトルをクリア・再入力 ----
  const titleSel = page.locator('[placeholder*="タイトル"], textarea[class*="title" i]').first();
  if (await titleSel.isVisible({ timeout: 5000 }).catch(() => false)) {
    await titleSel.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    await page.keyboard.type(title, { delay: 5 });
    logger.info(`[${key}] タイトル更新: ${title}`);
  }

  await page.waitForTimeout(500);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);

  // ---- 本文をクリア・再入力 ----
  const bodyEl = page.locator('.ProseMirror').first();
  if (await bodyEl.isVisible({ timeout: 5000 }).catch(() => false)) {
    await bodyEl.click();
    // 全選択して削除
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(200);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(500);

    // body テキストを挿入
    await page.evaluate(`
      (() => {
        const el = document.querySelector('.ProseMirror');
        if (el) {
          el.focus();
          document.execCommand('insertText', false, ${JSON.stringify(body)});
        }
      })()
    `);
    await page.waitForTimeout(1500);

    // bodyLen 確認
    const bodyLen = await page.evaluate(`
      (() => {
        const el = document.querySelector('.ProseMirror');
        return el ? (el.textContent || '').length : 0;
      })()
    `) as number;

    if (bodyLen < 50) {
      // フォールバック: keyboard.insertText
      logger.info(`[${key}] execCommand失敗 → keyboard.insertText`);
      await bodyEl.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.waitForTimeout(300);
      await page.keyboard.insertText(body);
    }

    logger.info(`[${key}] 本文入力: ${bodyLen}文字`);
    await page.waitForTimeout(1000);

    // ---- URL を <a> リンクに変換 ----
    await injectLinksIntoProseMirror(page);
    await page.waitForTimeout(500);
  }

  await page.screenshot({ path: `logs/note-edit-${key}-body.png` }).catch(() => {});

  // ---- 「公開に進む」→「投稿する」 ----
  const jsPublish = await page.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const btn = btns.find(b => {
        const t = (b.textContent || '').trim();
        return t.includes('公開に進む') || t === '投稿する' || t === '公開設定';
      });
      if (btn) { btn.click(); return (btn.textContent || '').trim(); }
      return null;
    })()
  `) as string | null;

  if (!jsPublish) {
    await page.screenshot({ path: `logs/note-edit-${key}-no-publish-btn.png` }).catch(() => {});
    logger.error(`[${key}] 「公開に進む」ボタンが見つかりません`);
    return null;
  }
  logger.info(`[${key}] クリック: ${jsPublish}`);

  // /publish/ ページへの遷移を待つ
  try {
    await page.waitForURL(/editor\.note\.com\/notes\/.+\/publish/, { timeout: 15000 });
  } catch {
    logger.warn(`[${key}] /publish/ 遷移タイムアウト. 現在: ${page.url()}`);
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(3000);

  // ---- 「投稿する」最終ボタン ----
  let finalClicked = false;
  for (let i = 1; i <= 3; i++) {
    const jsResult = await page.evaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const priorities = ['更新する', '投稿する', '無料で公開', '公開する', '公開', '保存する'];
        for (const kw of priorities) {
          const btn = [...btns].reverse().find(b => {
            const t = (b.textContent || '').trim();
            return t.includes(kw) && !b.disabled && b.getBoundingClientRect().width > 0;
          });
          if (btn) { btn.click(); return (btn.textContent || '').trim(); }
        }
        return null;
      })()
    `) as string | null;

    if (jsResult) {
      logger.info(`[${key}] 最終公開クリック (試行${i}): ${jsResult}`);
      finalClicked = true;
      break;
    }
    // 診断: ページ上のボタン一覧
    const btnDiag = await page.evaluate(`
      (() => Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter(b => b.getBoundingClientRect().width > 0)
        .map(b => ({ t: (b.textContent || '').trim().substring(0,30), d: !!b.disabled })))()
    `) as Array<{ t: string; d: boolean }>;
    logger.warn(`[${key}] 最終公開ボタン未検出 (試行${i}/3) ボタン一覧: ${JSON.stringify(btnDiag)}`);
    await page.waitForTimeout(2000);
  }

  if (!finalClicked) {
    await page.screenshot({ path: `logs/note-edit-${key}-no-final.png` }).catch(() => {});
    return null;
  }

  // 「更新する」クリック後はページが遷移する場合があるので try/catch
  await page.waitForTimeout(4000).catch(() => {});

  // 更新後は creator ID + noteId で URL が固定
  const fixedUrl = `https://note.com/${CREATOR_ID}/n/${noteId}`;
  logger.info(`[${key}] ✅ 更新完了 公開URL: ${fixedUrl}`);
  return fixedUrl;
}

async function main(): Promise<void> {
  logger.info('=== Note SEO 記事 編集・上書き公開 ===');

  if (!fs.existsSync(SESSION_FILE)) {
    logger.error(`セッションファイルなし: ${SESSION_FILE}`);
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
    const loggedIn = await page.locator('a[href*="/notes/new"], button:has-text("投稿")').first().isVisible({ timeout: 8000 }).catch(() => false);
    if (!loggedIn) {
      logger.error('note セッション期限切れ。npm run note:setup を実行してください。');
      process.exit(1);
    }

    const results: Record<string, string | null> = {};

    for (const article of ARTICLES) {
      logger.info(`\n${'─'.repeat(60)}`);
      const filePath = path.join(process.cwd(), article.file);
      if (!fs.existsSync(filePath)) {
        logger.error(`ファイルなし: ${filePath}`);
        continue;
      }
      const markdown = fs.readFileSync(filePath, 'utf-8');
      const { title, body } = markdownToNote(markdown);
      logger.info(`[${article.key}] タイトル: ${title}`);
      logger.info(`[${article.key}] 本文: ${body.length}文字`);

      const url = await editArticle(page, article.noteId, title, body, article.key);
      results[article.key] = url;

      if (article !== ARTICLES[ARTICLES.length - 1]) {
        logger.info('次の記事まで5秒待機...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    logger.info(`\n${'='.repeat(60)}`);
    logger.info('=== 公開結果 ===');
    for (const [key, url] of Object.entries(results)) {
      if (url) {
        logger.info(`  ✅ ${key}: ${url}`);
      } else {
        logger.error(`  ❌ ${key}: 失敗`);
      }
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
