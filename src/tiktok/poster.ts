import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { logger } from '../utils/logger';

export interface TikTokPosterOptions {
  username: string;
  password: string;
  dryRun?: boolean;
}

const SESSION_FILE = path.join(process.cwd(), 'state', 'tiktok-session.json');

/**
 * Playwright を使って TikTok に画像スライド投稿する。
 *
 * TikTok Creator Portal (tiktok.com/creator-center/upload) を Playwright で操作。
 * セッション管理は XPoster / InstagramPoster と同パターン。
 *
 * 注意: TikTok は動画が主流だが、このクラスは画像スライド（フォト投稿）を使う。
 * 画像が取得できない場合は投稿をスキップする。
 */
export class TikTokPoster {
  private opts: TikTokPosterOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private homePage: Page | null = null;

  constructor(opts: TikTokPosterOptions) {
    this.opts = opts;
  }

  async open(): Promise<boolean> {
    if (this.opts.dryRun) return true;

    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

    if (fs.existsSync(SESSION_FILE)) {
      logger.info('TikTok セッション読み込み中...');
      const ok = await this.connectWithSession();
      if (ok) return true;
      logger.warn('TikTok セッション期限切れ。自動再ログインします...');
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
   * TikTok に画像スライドを投稿する
   * @param caption  キャプションテキスト（ハッシュタグ含む、150字以内推奨）
   * @param imageUrl 添付画像 URL（必須）
   * @returns 投稿成功時 true
   */
  async post(caption: string, imageUrl?: string): Promise<boolean> {
    if (this.opts.dryRun) {
      logger.info(`[DRY-RUN] TikTok 投稿内容:\n${caption}`);
      if (imageUrl) logger.info(`[DRY-RUN] 画像: ${imageUrl}`);
      return true;
    }

    if (!this.homePage) {
      logger.error('ブラウザが起動していません。open() を先に呼んでください。');
      return false;
    }

    if (!imageUrl) {
      logger.warn('TikTok は画像必須のため、画像なし投稿はスキップします');
      return false;
    }

    let tmpPath: string | null = null;
    try {
      tmpPath = await this.downloadImage(imageUrl);
      if (!tmpPath) {
        logger.warn('TikTok 画像ダウンロード失敗 → スキップ');
        return false;
      }

      await this.postSlide(this.homePage, caption, tmpPath);
      logger.info('TikTok 投稿完了');
      return true;
    } catch (err) {
      logger.error(`TikTok 投稿失敗: ${err instanceof Error ? err.message : String(err)}`);
      await this.homePage.screenshot({ path: 'logs/tiktok-error.png' }).catch(() => {});
      return false;
    } finally {
      if (tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
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

    // Creator Center へ直接アクセスしてセッションが有効か検証
    await page.goto('https://www.tiktok.com/creator-center/upload', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    }).catch(() => {});
    await page.waitForTimeout(4000);

    // ログインページにリダイレクトされた場合はセッション期限切れ
    const currentUrl = page.url();
    const isOnLoginPage =
      currentUrl.includes('/login') ||
      currentUrl.includes('tiktok.com/login') ||
      await page.locator(':text("TikTokにログイン"), :text("Log in to TikTok")').first().isVisible({ timeout: 3000 }).catch(() => false);

    if (isOnLoginPage) {
      logger.warn('TikTok Creator Center セッションが期限切れ。再ログインします...');
      await page.screenshot({ path: 'logs/tiktok-session-expired.png' }).catch(() => {});
      await page.close();
      await this.close();
      return false;
    }

    // Creator Center が開けていることを確認
    const isLoggedIn = await page.locator(
      '[data-e2e="upload-zone"], input[type="file"], ' +
      'button:has-text("ファイルを選択"), button:has-text("Select files"), ' +
      '.upload-card, [class*="upload"]'
    ).first().isVisible({ timeout: 10000 }).catch(() => false);

    if (!isLoggedIn) {
      logger.warn('TikTok Creator Center が開けません。再ログインします...');
      await page.screenshot({ path: 'logs/tiktok-session-check-fail.png' }).catch(() => {});
      await page.close();
      await this.close();
      return false;
    }

    await this.context.storageState({ path: SESSION_FILE });
    this.homePage = page;
    logger.info('TikTok ログイン済み確認');
    return true;
  }

  // ----------------------------------------------------------------
  // 内部: headful でログイン → セッション保存
  // ----------------------------------------------------------------

  private async loginAndSave(): Promise<boolean> {
    const isCI = process.env['CI'] === 'true';
    logger.info(`TikTok に自動ログイン中... ${isCI ? '(CI: headless)' : '(ブラウザが開きます)'}`);
    this.browser = await chromium.launch({
      headless: isCI,
      slowMo: isCI ? 0 : 80,
      args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    });
    this.context = await this.browser.newContext();
    const page = await this.context.newPage();

    try {
      await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'logs/tiktok-login-step1.png' }).catch(() => {});

      // Step 1: 「電話番号/メール/ユーザー名を使う」ボタンをクリック
      // TikTok の実際のボタンテキストに対応した複数セレクター
      const step1Candidates = [
        // 日本語版（テキストを含む要素を幅広くマッチ）
        ':text("電話番号/メール")',
        ':text("電話番号")',
        // 英語版
        ':text("Use phone / email / username")',
        ':text("Phone / Email / Username")',
        ':text("Use phone")',
      ];
      let step1Clicked = false;
      for (const sel of step1Candidates) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 })) {
            await el.click();
            logger.info(`TikTok ログイン選択: ${sel}`);
            step1Clicked = true;
            await page.waitForTimeout(2000);
            break;
          }
        } catch { /* 次のセレクターを試す */ }
      }
      if (!step1Clicked) {
        logger.warn('TikTok ログイン選択ボタンが見つかりません。入力欄を直接探します...');
      }

      await page.screenshot({ path: 'logs/tiktok-login-step2.png' }).catch(() => {});

      // Step 2: 「メールアドレス/ユーザー名」タブを選択（電話番号タブが先に出る場合）
      const emailTabCandidates = [
        // 実際の日本語UI（スクリーンショット確認済み）
        ':text("メールまたはユーザー名でログイン")',
        ':text("メールアドレス/ユーザー名")',
        ':text("メール/ユーザー名")',
        'a:has-text("メール")',
        // 英語UI
        ':text("Email / Username")',
        ':text("Log in with email or username")',
        ':text("Email")',
      ];
      for (const sel of emailTabCandidates) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 })) {
            await el.click();
            logger.info(`TikTok タブ選択: ${sel}`);
            await page.waitForTimeout(1500);
            break;
          }
        } catch { /* ignore */ }
      }

      // メールアドレス/ユーザー名 入力
      const inputCandidates = [
        'input[name="username"]',
        'input[type="email"]',
        'input[type="text"]',
        'input[placeholder*="メール"]',
        'input[placeholder*="ユーザー名"]',
        'input[placeholder*="username"]',
        'input[placeholder*="email"]',
        'input[autocomplete="username"]',
      ];
      let emailInput = null;
      for (const sel of inputCandidates) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 5000 })) {
            emailInput = el;
            logger.info(`TikTok 入力欄検出: ${sel}`);
            break;
          }
        } catch { /* 次のセレクター */ }
      }
      if (!emailInput) {
        await page.screenshot({ path: 'logs/tiktok-no-input.png' }).catch(() => {});
        throw new Error('TikTok ユーザー名入力欄が見つかりません。npm run tiktok:setup で手動ログインしてください');
      }
      await emailInput.waitFor({ timeout: 10000 });
      await emailInput.fill(this.opts.username);
      await page.waitForTimeout(800);

      // Step 2.5: メール入力後に「次へ」ボタンが出る場合（2ステップログインフロー）
      const nextBtnCandidates = [
        'button:has-text("次へ")',
        'button:has-text("Next")',
        'button:has-text("続ける")',
        'button:has-text("Continue")',
      ];
      for (const sel of nextBtnCandidates) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 }) && await el.isEnabled({ timeout: 1000 })) {
            await el.click();
            logger.info(`TikTok 「次へ」ボタンクリック: ${sel}`);
            await page.waitForTimeout(1500);
            break;
          }
        } catch { /* ignore */ }
      }

      // パスワード入力（「次へ」後に表示されることがある）
      const pwInput = page.locator('input[type="password"]').first();
      await pwInput.waitFor({ timeout: 8000 }).catch(() => {});
      await pwInput.fill(this.opts.password);
      await page.waitForTimeout(600);

      // ログインボタン（enabled になるまで最大5秒待つ）
      const loginBtn = page.locator('button[type="submit"], button[data-e2e="login-button"]').first();
      await loginBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      // enabled になるまで待機
      for (let i = 0; i < 10; i++) {
        const enabled = await loginBtn.isEnabled().catch(() => false);
        if (enabled) break;
        await page.waitForTimeout(500);
      }
      await loginBtn.click({ force: true });
      logger.info('TikTok ログインボタンをクリック');
      await page.waitForTimeout(8000);

      // ログイン確認
      const isLoggedIn = await page.locator(
        '[data-e2e="upload-icon"], [data-e2e="nav-upload"], a[href*="/@"]'
      ).first().isVisible({ timeout: 12000 }).catch(() => false);

      if (!isLoggedIn) {
        logger.error('TikTok ログイン失敗（CAPTCHA または 2FA が必要な可能性があります）');
        await page.screenshot({ path: 'logs/tiktok-login-failed.png' }).catch(() => {});
        await page.close();
        await this.close();
        return false;
      }

      await this.context.storageState({ path: SESSION_FILE });
      logger.info(`TikTok ログイン成功。セッション保存: ${SESSION_FILE}`);
      this.homePage = page;
      return true;
    } catch (err) {
      logger.error(`TikTok ログインエラー: ${err instanceof Error ? err.message : String(err)}`);
      await page.screenshot({ path: 'logs/tiktok-login-error.png' }).catch(() => {});
      await page.close().catch(() => {});
      await this.close();
      return false;
    }
  }

  // ----------------------------------------------------------------
  // 公開: テキストカード画像を生成（画像 URL が取得できない場合のフォールバック）
  // ----------------------------------------------------------------

  /**
   * 1080×1080 のグラデーション背景 + テキスト PNG を生成して tmp/ に保存する。
   * Instagram と同パターン。既存ブラウザコンテキストを再利用する。
   */
  async generateTextCard(opts: {
    title: string;
    categoryEmoji: string;
    categoryLabel: string;
  }): Promise<string | null> {
    if (this.opts.dryRun) return null;

    const tmpDir = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const outPath = path.join(tmpDir, `tiktok-card-${Date.now()}.png`);

    let ownBrowser = false;
    let browser: Browser | null = null;
    let ctx: BrowserContext | null = null;

    try {
      if (this.context) {
        ctx = this.context;
      } else {
        browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        ctx = await browser.newContext();
        ownBrowser = true;
      }

      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1080, height: 1080 });

      const title = opts.title.length > 60
        ? opts.title.slice(0, 57) + '…'
        : opts.title;

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1080px; height: 1080px; overflow: hidden;
    background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
    display: flex; flex-direction: column;
    justify-content: center; align-items: center;
    font-family: "Noto Sans JP", "Hiragino Sans", sans-serif;
    color: white; padding: 80px;
  }
  .badge {
    font-size: 28px; font-weight: 700; letter-spacing: 2px;
    color: #7ec8e3; text-transform: uppercase; margin-bottom: 32px;
  }
  .emoji { font-size: 40px; margin-bottom: 12px; }
  .title {
    font-size: 52px; font-weight: 800; line-height: 1.4;
    text-align: center; text-shadow: 0 2px 12px rgba(0,0,0,0.5);
    margin-bottom: 48px;
  }
  .footer {
    position: absolute; bottom: 60px;
    font-size: 22px; color: rgba(255,255,255,0.5); letter-spacing: 1px;
  }
</style>
</head>
<body>
  <div class="emoji">${opts.categoryEmoji}</div>
  <div class="badge">${opts.categoryLabel}</div>
  <div class="title">${title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  <div class="footer">AI News Daily</div>
</body>
</html>`;

      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.screenshot({ path: outPath, type: 'png' });
      await page.close();

      logger.info(`TikTok テキストカード生成: ${outPath}`);
      return outPath;
    } catch (err) {
      logger.warn(`TikTok テキストカード生成失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (ownBrowser) {
        await ctx?.close().catch(() => {});
        await browser?.close().catch(() => {});
      }
    }
  }

  // ----------------------------------------------------------------
  // 内部: 画像ダウンロード → tmp/ に保存
  // ----------------------------------------------------------------

  private async downloadImage(imageUrl: string): Promise<string | null> {
    // file:// パスはローカルファイルを直接使用（generateTextCard の出力など）
    if (imageUrl.startsWith('file://')) {
      const localPath = imageUrl.replace(/^file:\/\//, '');
      if (fs.existsSync(localPath)) return localPath;
      logger.warn(`TikTok file:// パスが存在しません: ${localPath}`);
      return null;
    }

    try {
      const res = await axios.get<ArrayBuffer>(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 12000,
        maxRedirects: 3,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AINewsBot/1.0)' },
      });

      const buf = Buffer.from(res.data);
      if (buf.byteLength > 20 * 1024 * 1024) {
        logger.warn(`画像サイズ超過 (${Math.round(buf.byteLength / 1024)}KB > 20MB) → スキップ`);
        return null;
      }

      const ct = (res.headers['content-type'] as string) || '';
      let ext = 'jpg';
      if      (ct.includes('png'))  ext = 'png';
      else if (ct.includes('webp')) ext = 'jpg';
      else {
        const urlExt = imageUrl.split('.').pop()?.split('?')[0]?.toLowerCase() ?? '';
        if (['jpg', 'jpeg', 'png'].includes(urlExt)) ext = urlExt === 'jpeg' ? 'jpg' : urlExt;
      }

      const tmpDir = path.join(process.cwd(), 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpPath = path.join(tmpDir, `tiktok-img-${Date.now()}.${ext}`);
      fs.writeFileSync(tmpPath, buf);
      logger.info(`TikTok 画像保存: ${tmpPath} (${Math.round(buf.byteLength / 1024)} KB)`);
      return tmpPath;
    } catch (err) {
      logger.warn(`TikTok 画像ダウンロード失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ----------------------------------------------------------------
  // 内部: TikTok Creator Portal で画像スライド投稿
  // ----------------------------------------------------------------

  private async postSlide(page: Page, caption: string, tmpPath: string): Promise<void> {
    // Creator Portal のアップロードページへ（既に開いている場合はリロード）
    const currentUrl = page.url();
    if (!currentUrl.includes('creator-center/upload')) {
      await page.goto('https://www.tiktok.com/creator-center/upload', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await page.waitForTimeout(4000);
    await page.screenshot({ path: 'logs/tiktok-upload.png' }).catch(() => {});

    // ログインページへのリダイレクト検出
    const afterNavUrl = page.url();
    if (afterNavUrl.includes('/login')) {
      throw new Error('TikTok セッション期限切れ（ログインページへリダイレクト）。npm run tiktok:setup で再セットアップしてください');
    }

    // 「画像」タブを選択（動画タブがデフォルトの場合）
    const photoTabSelectors = [
      'button:has-text("画像")',
      'button:has-text("Photo")',
      '[data-e2e="photo-tab"]',
    ];
    for (const sel of photoTabSelectors) {
      const tab = page.locator(sel).first();
      if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tab.click();
        logger.info(`TikTok 画像タブ選択: ${sel}`);
        await page.waitForTimeout(1500);
        break;
      }
    }

    // ファイル選択（input[type="file"] 経由）
    const fileInputSelectors = [
      'input[type="file"][accept*="image"]',
      'input[type="file"]',
    ];
    let fileSet = false;
    for (const sel of fileInputSelectors) {
      const fileInput = page.locator(sel).first();
      if (await fileInput.isVisible({ timeout: 3000 }).catch(() => false) ||
          await fileInput.count() > 0) {
        await fileInput.setInputFiles(tmpPath);
        logger.info('TikTok 画像ファイルをセット');
        fileSet = true;
        await page.waitForTimeout(4000);
        break;
      }
    }

    if (!fileSet) {
      // fileChooser イベント経由で試みる
      const uploadAreaSelectors = [
        '[data-e2e="upload-zone"]',
        'button:has-text("ファイルを選択"), button:has-text("Select files")',
        '.upload-zone',
      ];
      for (const sel of uploadAreaSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 8000 }),
            el.click(),
          ]);
          await fileChooser.setFiles(tmpPath);
          logger.info(`TikTok fileChooser 経由でファイルをセット: ${sel}`);
          fileSet = true;
          await page.waitForTimeout(4000);
          break;
        }
      }
    }

    if (!fileSet) {
      await page.screenshot({ path: 'logs/tiktok-no-upload.png' }).catch(() => {});
      throw new Error('TikTok ファイルアップロードエリアが見つかりません');
    }

    // キャプション入力
    const captionSelectors = [
      '[data-e2e="caption-area"] [contenteditable="true"]',
      'div[contenteditable="true"][data-e2e*="caption"]',
      '.caption-editor [contenteditable="true"]',
      'div[contenteditable="true"]',
    ];
    let captionSet = false;
    for (const sel of captionSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        await el.click();
        // 既存テキストをクリアして入力
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Delete');
        await page.keyboard.type(caption, { delay: 10 });
        logger.info(`TikTok キャプション入力完了: ${caption.length}文字`);
        captionSet = true;
        await page.waitForTimeout(800);
        break;
      }
    }
    if (!captionSet) {
      logger.warn('TikTok キャプション入力欄が見つかりません。空キャプションで続行します。');
    }

    // 「投稿」ボタンをクリック
    const postBtnSelectors = [
      'button:has-text("投稿"), button:has-text("Post")',
      '[data-e2e="post-button"]',
      'button[class*="submit"]',
    ];
    let posted = false;
    for (const sel of postBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await btn.click();
        logger.info(`TikTok 投稿ボタンクリック: ${sel}`);
        posted = true;
        break;
      }
    }
    if (!posted) {
      await page.screenshot({ path: 'logs/tiktok-no-post-btn.png' }).catch(() => {});
      throw new Error('TikTok 投稿ボタンが見つかりません');
    }

    await page.waitForTimeout(6000);
    await page.screenshot({ path: 'logs/tiktok-after-post.png' }).catch(() => {});
    logger.info('TikTok 投稿処理完了');
  }
}
