import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

export interface NotePosterOptions {
  email: string;
  password: string;
  dryRun?: boolean;
}

const SESSION_FILE = path.join(process.cwd(), 'state', 'note-session.json');

/**
 * Playwright を使って note に記事を投稿する。
 *
 * セッション管理は XPoster / InstagramPoster と同パターン。
 * 下書き保存 → 公開 の2ステップで投稿する。
 */
export class NotePublisher {
  private opts: NotePosterOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private homePage: Page | null = null;

  constructor(opts: NotePosterOptions) {
    this.opts = opts;
  }

  async open(): Promise<boolean> {
    if (this.opts.dryRun) return true;

    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

    if (fs.existsSync(SESSION_FILE)) {
      logger.info('note セッション読み込み中...');
      const ok = await this.connectWithSession();
      if (ok) return true;
      logger.warn('note セッション期限切れ。自動再ログインします...');
    }

    return this.loginAndSave();
  }

  async close(): Promise<void> {
    if (this.homePage) {
      try { await this.homePage.close(); } catch { /* ignore */ }
      this.homePage = null;
    }
    if (this.context) {
      try { await this.context.close(); } catch { /* ignore */ }
      this.context = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
  }

  /**
   * note に記事を投稿する
   * @param title   記事タイトル
   * @param body    記事本文（プレーンテキスト、改行区切り）
   * @returns 公開済み記事の URL（失敗時は null）
   */
  async publish(title: string, body: string): Promise<string | null> {
    if (this.opts.dryRun) {
      logger.info(`[DRY-RUN] note 投稿内容:\n${title}\n---\n${body.slice(0, 300)}...`);
      return 'https://note.com/dry-run';
    }

    if (!this.homePage) {
      logger.error('ブラウザが起動していません。open() を先に呼んでください。');
      return null;
    }

    try {
      const url = await this.postArticle(this.homePage, title, body);
      logger.info(`note 記事投稿完了: ${url}`);
      return url;
    } catch (err) {
      logger.error(`note 投稿失敗: ${err instanceof Error ? err.message : String(err)}`);
      await this.homePage.screenshot({ path: 'logs/note-error.png' }).catch(() => {});
      return null;
    }
  }

  // ----------------------------------------------------------------
  // 内部: セッションファイルを使って接続
  // ----------------------------------------------------------------

  private async connectWithSession(): Promise<boolean> {
    const isCI = process.env['CI'] === 'true';
    this.browser = await chromium.launch({
      headless: isCI,
      args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    });
    this.context = await this.browser.newContext({ storageState: SESSION_FILE });
    const page = await this.context.newPage();

    await page.goto('https://note.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // ログイン確認: 投稿ボタン or ユーザーアイコン
    const isLoggedIn = await page.locator(
      'a[href*="/notes/new"], [data-cy="header-post-button"], ' +
      'button:has-text("投稿"), a[href*="/settings"]'
    ).first().isVisible({ timeout: 8000 }).catch(() => false);

    if (!isLoggedIn) {
      logger.warn('note セッションが期限切れです。再ログインします...');
      await page.screenshot({ path: 'logs/note-session-expired.png' }).catch(() => {});
      await page.close();
      await this.close();
      return false;
    }

    await this.context.storageState({ path: SESSION_FILE });
    this.homePage = page;
    logger.info('note ログイン済み確認');
    return true;
  }

  // ----------------------------------------------------------------
  // 内部: headful でログイン → セッション保存
  // ----------------------------------------------------------------

  private async loginAndSave(): Promise<boolean> {
    const isCI = process.env['CI'] === 'true';
    logger.info(`note に自動ログイン中... ${isCI ? '(CI: headless)' : '(ブラウザが開きます)'}`);
    this.browser = await chromium.launch({
      headless: isCI,
      slowMo: isCI ? 0 : 80,
      args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    });
    this.context = await this.browser.newContext();
    const page = await this.context.newPage();

    try {
      await page.goto('https://note.com/login', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'logs/note-login-page.png' }).catch(() => {});

      // メールアドレス入力（note.com のログインフォームは type="text" の場合がある）
      const emailSelectors = [
        'input[name="email"]',
        'input[type="email"]',
        'input[type="text"]',
        'input[placeholder*="メール"]',
        'input[placeholder*="email" i]',
        'input[autocomplete="email"]',
        'input[autocomplete="username"]',
      ];
      let emailInput = null;
      for (const sel of emailSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
          emailInput = el;
          logger.info(`note ログイン: メール入力欄検出 [${sel}]`);
          break;
        }
      }
      if (!emailInput) {
        await page.screenshot({ path: 'logs/note-login-failed.png' }).catch(() => {});
        logger.error('note ログイン: メール入力欄が見つかりません');
        await page.close();
        await this.close();
        return false;
      }
      await emailInput.fill(this.opts.email);
      await page.waitForTimeout(500);

      // パスワード入力
      const pwInput = page.locator('input[type="password"]').first();
      if (await pwInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await pwInput.fill(this.opts.password);
      }
      await page.waitForTimeout(500);

      // ログインボタン（JS evaluate で確実にクリック）
      const jsLoginClicked = await page.evaluate(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
          const btn = btns.find(b => {
            const t = (b.textContent || b.value || '').trim();
            return ['ログイン', 'Login', 'サインイン', 'Sign in'].includes(t) || b.type === 'submit';
          });
          if (btn) { btn.click(); return btn.textContent || btn.type; }
          return null;
        })()
      `) as string | null;
      if (jsLoginClicked) {
        logger.info(`note ログインボタンクリック (JS): ${jsLoginClicked}`);
      } else {
        const loginBtn = page.locator('button[type="submit"], button:has-text("ログイン")').first();
        if (await loginBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await loginBtn.click();
          logger.info('note ログインボタンクリック');
        }
      }

      await page.waitForTimeout(5000);

      // ログイン確認
      const isLoggedIn = await page.locator(
        'a[href*="/notes/new"], [data-cy="header-post-button"], ' +
        'button:has-text("投稿"), a[href*="/settings"]'
      ).first().isVisible({ timeout: 15000 }).catch(() => false);

      if (!isLoggedIn) {
        logger.error('note ログイン失敗');
        await page.screenshot({ path: 'logs/note-login-failed.png' }).catch(() => {});
        await page.close();
        await this.close();
        return false;
      }

      await this.context.storageState({ path: SESSION_FILE });
      logger.info(`note ログイン成功。セッション保存: ${SESSION_FILE}`);
      this.homePage = page;
      return true;
    } catch (err) {
      logger.error(`note ログインエラー: ${err instanceof Error ? err.message : String(err)}`);
      await page.screenshot({ path: 'logs/note-login-error.png' }).catch(() => {});
      await page.close().catch(() => {});
      await this.close();
      return false;
    }
  }

  // ----------------------------------------------------------------
  // 内部: note エディタで記事を投稿
  // ----------------------------------------------------------------

  private async postArticle(page: Page, title: string, body: string): Promise<string> {
    // note ホームから「投稿する」ボタンを経由してエディタを開く
    // (直接 /notes/new を開くとローディングが完了しないケースがある)
    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 「投稿する」ボタンをクリックしてエディタを開く
    const postBtnLocators = [
      page.getByRole('button', { name: '投稿する', exact: true }),
      page.locator('a[href*="/notes/new"]').first(),
      page.locator('button:has-text("投稿する")').first(),
      page.locator('[data-cy="header-post-button"]').first(),
      page.locator(':text-is("投稿する")').first(),
    ];
    let openedEditor = false;
    for (const btn of postBtnLocators) {
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click();
        logger.info('[note] 「投稿する」ボタンクリック');
        openedEditor = true;
        break;
      }
    }
    if (!openedEditor) {
      // 直接 /notes/new へ
      logger.info('[note] 投稿ボタン未検出 → /notes/new へ直接移動');
      await page.goto('https://note.com/notes/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    // エディタの contenteditable が表示されるまで最大30秒待機
    logger.info('[note] エディタ起動待機中...');
    await page.waitForSelector('[contenteditable], textarea', { timeout: 30000 }).catch(() => {
      logger.warn('[note] エディタ起動タイムアウト（30秒）');
    });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'logs/note-editor.png' }).catch(() => {});

    // ---- 診断: DOM構造を確認 ----
    try {
      const editableInfo = await page.evaluate(`
        (() => {
          const items = [];
          document.querySelectorAll('[contenteditable], textarea, input[type="text"]').forEach(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0) {
              items.push({
                tag: el.tagName,
                contenteditable: el.getAttribute('contenteditable'),
                placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder'),
                className: el.className.toString().substring(0, 60),
                visible: rect.width > 0 && rect.height > 0,
              });
            }
          });
          return items;
        })()
      `) as unknown[];
      logger.info(`[note診断] 入力可能要素: ${JSON.stringify(editableInfo, null, 2)}`);
    } catch { /* ignore */ }

    // タイトル入力 — note.com のエディタに合わせた多様なセレクター
    const titleSelectors = [
      '[placeholder*="タイトル"]',
      '[data-placeholder*="タイトル"]',
      'textarea[class*="title" i]',
      'input[class*="title" i]',
      '[data-cy="editor-title"]',
      '.editor-title',
      'h1[contenteditable="true"]',
      'textarea[name="title"]',
      'div[contenteditable="true"]',  // 最初の contenteditable をタイトルとして使う
    ];
    let titleInput = null;
    for (const sel of titleSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        titleInput = el;
        logger.info(`[note] タイトル入力欄検出: ${sel}`);
        break;
      }
    }
    // JS evaluate で直接クリックして入力するフォールバック
    if (!titleInput) {
      const jsTitleClicked = await page.evaluate(`
        (() => {
          const el = document.querySelector('[contenteditable], textarea, input[type="text"]');
          if (el && el.getBoundingClientRect().width > 0) {
            el.focus();
            return el.tagName + ':' + (el.className || '').toString().substring(0, 40);
          }
          return null;
        })()
      `) as string | null;

      if (jsTitleClicked) {
        logger.info(`[note] タイトル欄 JS フォーカス: ${jsTitleClicked}`);
        // 最初の contenteditable / textarea を locator で参照
        titleInput = page.locator('[contenteditable], textarea, input[type="text"]').first();
      }
    }

    if (!titleInput) {
      await page.screenshot({ path: 'logs/note-no-title.png' }).catch(() => {});
      throw new Error('note タイトル入力欄が見つかりません');
    }
    await titleInput.click();
    await page.keyboard.type(title, { delay: 10 });
    logger.info(`[note] タイトル入力完了: ${title}`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'logs/note-after-title.png' }).catch(() => {});

    // タイトル欄から本文欄へ移動（Tab or Enter）
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);

    // 本文入力エリアを特定
    const allEditable = page.locator('[contenteditable="true"], [contenteditable]');
    const editableCount = await allEditable.count();
    logger.info(`[note] contenteditable 要素数: ${editableCount}`);

    let bodyInput = null;
    // 2番目以降の contenteditable を本文欄として使用
    if (editableCount >= 2) {
      bodyInput = allEditable.nth(1);
      logger.info('[note] 本文入力欄: contenteditable[1]');
    } else if (editableCount === 1) {
      // タイトルと本文が同一の要素のケース（Enter で段落追加）
      bodyInput = allEditable.nth(0);
      logger.info('[note] 本文入力欄: contenteditable[0]（タイトルと共有）');
    } else {
      await page.screenshot({ path: 'logs/note-no-body.png' }).catch(() => {});
      throw new Error('note 本文入力欄が見つかりません');
    }

    await bodyInput.click();
    await page.waitForTimeout(300);

    // 本文をクリップボード経由で高速入力（keyboard.type は遅いため）
    await page.evaluate(`
      (() => {
        const body = ${JSON.stringify(body)};
        const el = document.querySelector('.ProseMirror, [contenteditable="true"]');
        if (el) {
          el.focus();
          // execCommand('insertText') で直接挿入
          document.execCommand('insertText', false, body);
        }
      })()
    `);
    await page.waitForTimeout(1000);

    // execCommand が効かない場合は insertText API で代替
    const bodyLen = await page.evaluate(`
      (() => {
        const el = document.querySelector('.ProseMirror, [contenteditable="true"]');
        return el ? (el.textContent || '').length : 0;
      })()
    `) as number;

    if (bodyLen < 100) {
      // フォールバック: keyboard.insertText（delay なしで一括入力）
      logger.info('[note] execCommand失敗 → keyboard.insertText でフォールバック');
      await bodyInput.click();
      await page.keyboard.insertText(body);
    }
    logger.info(`[note] 本文入力完了: ${body.length}文字`);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'logs/note-after-body.png' }).catch(() => {});

    // ステップ1: 「公開に進む」をクリック → editor.note.com/notes/{id}/publish/ へ遷移
    let step1Clicked = false;

    // JS evaluate で「公開に進む」を探す（テキスト部分一致）
    const jsStep1 = await page.evaluate(`
      (() => {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const btn = candidates.find(el => {
          const text = (el.textContent || '').trim();
          return text.includes('公開に進む') || text.includes('公開設定') || text === '投稿する' || text === '公開する';
        });
        if (btn) { btn.click(); return (btn.textContent || '').trim(); }
        return null;
      })()
    `) as string | null;

    if (jsStep1) {
      logger.info(`[note] Step1 公開ボタンクリック (JS): ${jsStep1}`);
      step1Clicked = true;
    } else {
      const step1Locators = [
        page.locator('button').filter({ hasText: '公開に進む' }).first(),
        page.locator('button').filter({ hasText: '公開設定' }).first(),
        page.locator('button').filter({ hasText: '投稿する' }).first(),
      ];
      for (const btn of step1Locators) {
        if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await btn.click();
          logger.info('[note] Step1 公開ボタンクリック（Playwright）');
          step1Clicked = true;
          break;
        }
      }
    }
    if (!step1Clicked) {
      await page.screenshot({ path: 'logs/note-no-publish-btn.png' }).catch(() => {});
      throw new Error('note 公開設定ボタンが見つかりません');
    }

    // ステップ2: editor.note.com/notes/{id}/publish/ ページの読み込みを待つ
    // URL が /publish/ になるまで最大15秒待機
    try {
      await page.waitForURL(/editor\.note\.com\/notes\/.+\/publish/, { timeout: 15000 });
      logger.info(`[note] 公開設定ページ遷移完了: ${page.url()}`);
    } catch {
      logger.warn(`[note] 公開設定ページ遷移タイムアウト。現在URL: ${page.url()}`);
    }
    // ページが安定するまで待機
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'logs/note-publish-dialog.png' }).catch(() => {});

    // 診断: publish ページのボタン一覧をログ出力
    try {
      const btnDiag = await page.evaluate(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
          return btns
            .filter(b => b.getBoundingClientRect().width > 0)
            .map(b => ({ text: (b.textContent || b.value || '').trim().substring(0, 60), disabled: !!b.disabled }));
        })()
      `) as Array<{ text: string; disabled: boolean }>;
      logger.info(`[note] publish ページのボタン: ${JSON.stringify(btnDiag)}`);
    } catch { /* ignore */ }

    // ステップ3: 「無料で公開する」 / 「公開する」ボタンをクリック
    // テキスト部分一致 + disabled チェック付き
    let step3Clicked = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // JS evaluate: disabled でなく「公開」を含む最後のボタンを押す
      const jsStep3 = await page.evaluate(`
        (() => {
          const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
          // 優先順: "無料で公開" > "公開する" > "公開"
          const priorities = ['投稿する', '無料で公開', '公開する', '公開', 'Publish'];
          for (const keyword of priorities) {
            const btn = candidates.reverse().find(el => {
              const text = (el.textContent || el.value || '').trim();
              return text.includes(keyword) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
                     && el.getBoundingClientRect().width > 0;
            });
            if (btn) { btn.click(); return (btn.textContent || btn.value || '').trim(); }
          }
          return null;
        })()
      `) as string | null;

      if (jsStep3) {
        logger.info(`[note] Step3 最終公開クリック (JS, 試行${attempt}): ${jsStep3}`);
        step3Clicked = true;
        break;
      }

      // Playwright フォールバック
      const step3Locators = [
        page.locator('button').filter({ hasText: '投稿する' }).last(),
        page.locator('button').filter({ hasText: '無料で公開する' }).last(),
        page.locator('button').filter({ hasText: '公開する' }).last(),
        page.locator('button').filter({ hasText: '公開' }).last(),
      ];
      for (const btn of step3Locators) {
        if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn.click();
          logger.info(`[note] Step3 最終公開クリック（Playwright, 試行${attempt}）`);
          step3Clicked = true;
          break;
        }
      }
      if (step3Clicked) break;

      logger.warn(`[note] Step3 公開ボタン未検出（試行${attempt}/3）。2秒待機して再試行...`);
      await page.waitForTimeout(2000);
    }
    if (!step3Clicked) {
      await page.screenshot({ path: 'logs/note-no-final-btn.png' }).catch(() => {});
      throw new Error('note 最終公開ボタン（無料で公開する）が見つかりません');
    }

    // 公開完了後のURL取得
    // note.com は公開後も editor.note.com/notes/{id}/publish/ にとどまる場合がある
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'logs/note-after-publish.png' }).catch(() => {});

    let publishedUrl = '';

    // Try 1: ページ内に公開記事へのリンクがあるか検索
    try {
      const foundUrl = await page.evaluate(`
        (() => {
          const links = Array.from(document.querySelectorAll('a[href]'));
          const noteLink = links.find(a => {
            const href = a.href || '';
            return /note\\.com\\/[^/]+\\/n\\/[a-z0-9]+/.test(href) && !href.includes('editor.note.com');
          });
          return noteLink ? noteLink.href : null;
        })()
      `) as string | null;
      if (foundUrl) {
        publishedUrl = foundUrl;
        logger.info(`[note] 公開URL取得（ページリンク）: ${publishedUrl}`);
      }
    } catch { /* ignore */ }

    // Try 2: エディタURL から note ID を抽出して公開URLへナビゲート
    // editor.note.com/notes/{noteId}/publish/ → https://note.com/n/{noteId} へリダイレクト
    if (!publishedUrl) {
      const editorUrl = page.url();
      const noteIdMatch = editorUrl.match(/\/notes\/([a-z0-9]+)/);
      if (noteIdMatch) {
        const noteSlug = noteIdMatch[1];
        try {
          await page.goto(`https://note.com/n/${noteSlug}`, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });
          publishedUrl = page.url();
          logger.info(`[note] 公開URL取得（リダイレクト）: ${publishedUrl}`);
        } catch {
          publishedUrl = editorUrl;
          logger.warn(`[note] リダイレクト取得失敗。エディタURL: ${publishedUrl}`);
        }
      } else {
        publishedUrl = page.url();
        logger.warn(`[note] URLパターン未検出: ${publishedUrl}`);
      }
    }

    logger.info('[note] 記事公開完了');
    return publishedUrl;
  }
}
