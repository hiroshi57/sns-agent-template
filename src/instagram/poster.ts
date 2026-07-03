import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { logger } from '../utils/logger';

export interface InstagramPosterOptions {
  username: string;
  password: string;
  dryRun?: boolean;
  /**
   * Threads にも同時投稿するか（デフォルト: false）
   *
   * 注意: Instagram セッション (instagram.com) の Cookie は threads.net では
   * 使えないため、Threads への投稿は別途セッション確立が必要。
   * 現時点では Threads は未サポート。true にしても silent skip される。
   * TODO: Threads 専用ログイン実装後に有効化する。
   */
  postToThreads?: boolean;
}

const SESSION_FILE = path.join(process.cwd(), 'state', 'instagram-session.json');

/**
 * Playwright を使って Instagram (Web) と Threads に投稿する。
 *
 * セッション管理は XPoster と同パターン:
 * 1. state/instagram-session.json が存在して有効なら再利用
 * 2. 期限切れ or 存在しなければ headful で自動ログイン
 *
 * ページ再利用戦略:
 * - open() で確立した homePage を全投稿で再利用
 */
export class InstagramPoster {
  private opts: InstagramPosterOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private homePage: Page | null = null;

  constructor(opts: InstagramPosterOptions) {
    // postToThreads のデフォルトは false（Threads 専用セッション未実装のため）
    this.opts = { postToThreads: false, ...opts };
  }

  async open(): Promise<boolean> {
    if (this.opts.dryRun) return true;

    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

    if (fs.existsSync(SESSION_FILE)) {
      logger.info('Instagram セッション読み込み中...');
      const ok = await this.connectWithSession();
      if (ok) return true;
      logger.warn('Instagram セッション期限切れ。自動再ログインします...');
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
   * Instagram に投稿する（Threads にも同時投稿）
   * @param text     本文テキスト（ハッシュタグ含む）
   * @param imageUrl 添付画像 URL（省略可）
   */
  async post(text: string, imageUrl?: string): Promise<boolean> {
    if (this.opts.dryRun) {
      logger.info(`[DRY-RUN] Instagram 投稿内容:\n${text}`);
      if (imageUrl) logger.info(`[DRY-RUN] 画像: ${imageUrl}`);
      return true;
    }

    if (!this.homePage) {
      logger.error('ブラウザが起動していません。open() を先に呼んでください。');
      return false;
    }

    // 画像は一度だけダウンロードして Instagram / Threads の両方で再利用
    let tmpPath: string | null = null;
    try {
      if (imageUrl) {
        tmpPath = await this.downloadImage(imageUrl);
      }

      await this.postToInstagram(this.homePage, text, tmpPath);
      logger.info('Instagram 投稿完了');

      if (this.opts.postToThreads) {
        await this.postToThreadsApp(text, tmpPath);
      }

      return true;
    } catch (err) {
      logger.error(`Instagram 投稿失敗: ${err instanceof Error ? err.message : String(err)}`);
      await this.homePage.screenshot({ path: 'logs/instagram-error.png' }).catch(() => {});
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
      headless: true,
      args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    });
    this.context = await this.browser.newContext({ storageState: SESSION_FILE });
    const page = await this.context.newPage();

    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // ログイン済み確認: 新規投稿ボタン or プロフィールアイコン
    const isLoggedIn = await page.locator('svg[aria-label="新規投稿"], svg[aria-label="New post"], a[href*="/direct/"]')
      .first().isVisible({ timeout: 8000 }).catch(() => false);

    if (!isLoggedIn) {
      logger.warn('Instagram セッションが期限切れです。再ログインします...');
      await page.screenshot({ path: 'logs/instagram-session-expired.png' }).catch(() => {});
      await page.close();
      await this.close();
      return false;
    }

    await this.context.storageState({ path: SESSION_FILE });
    this.homePage = page;
    logger.info('Instagram ログイン済み確認');
    return true;
  }

  // ----------------------------------------------------------------
  // 内部: headful でログイン → セッション保存
  // ----------------------------------------------------------------

  private async loginAndSave(): Promise<boolean> {
    const isCI = process.env['CI'] === 'true';
    logger.info(`Instagram に自動ログイン中... ${isCI ? '(CI: headless)' : '(ブラウザが開きます)'}`);
    this.browser = await chromium.launch({
      headless: true,
      slowMo: isCI ? 0 : 80,
      args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    });
    this.context = await this.browser.newContext();
    const page = await this.context.newPage();

    try {
      await page.goto('https://www.instagram.com/accounts/login/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // ユーザー名入力
      const usernameInput = page.locator('input[name="username"]').first();
      await usernameInput.waitFor({ timeout: 15000 });
      await usernameInput.fill(this.opts.username);
      await page.waitForTimeout(500);

      // パスワード入力
      const passwordInput = page.locator('input[name="password"]').first();
      await passwordInput.fill(this.opts.password);
      await page.waitForTimeout(500);

      // ログインボタン
      const loginBtn = page.locator('button[type="submit"]').first();
      await loginBtn.click();
      logger.info('Instagram ログインボタンをクリック');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info('CAPTCHA・SMS認証・2FA が表示された場合は手動で完了してください。');
      logger.info('最大 3分間 待機します...');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // ログイン完了まで最大 3分待機（CAPTCHA・SMS・2FA 対応）
      const LOGIN_TIMEOUT_MS = 3 * 60 * 1000; // 3分
      const loginSuccessLocator = page.locator(
        'svg[aria-label="新規投稿"], svg[aria-label="New post"], ' +
        'a[href*="/direct/"], [aria-label="ホーム"], [aria-label="Home"]'
      ).first();
      const isLoggedIn = await loginSuccessLocator
        .isVisible({ timeout: LOGIN_TIMEOUT_MS })
        .catch(() => false);

      if (isLoggedIn) {
        // 「ログイン情報を保存しますか？」ダイアログを閉じる
        const notNowBtn = page.locator('button:has-text("後で"), button:has-text("Not Now")').first();
        if (await notNowBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await notNowBtn.click();
          logger.info('「後で」ボタンをクリック（ログイン情報保存ダイアログ）');
          await page.waitForTimeout(1500);
        }

        // 通知許可ダイアログを閉じる
        const notNowNotif = page.locator('button:has-text("後で"), button:has-text("Not Now")').first();
        if (await notNowNotif.isVisible({ timeout: 3000 }).catch(() => false)) {
          await notNowNotif.click();
          await page.waitForTimeout(1000);
        }
      }

      if (!isLoggedIn) {
        logger.error('Instagram ログイン失敗');
        await page.screenshot({ path: 'logs/instagram-login-failed.png' }).catch(() => {});
        await page.close();
        await this.close();
        return false;
      }

      await this.context.storageState({ path: SESSION_FILE });
      logger.info(`Instagram ログイン成功。セッション保存: ${SESSION_FILE}`);
      this.homePage = page;
      return true;
    } catch (err) {
      logger.error(`Instagram ログインエラー: ${err instanceof Error ? err.message : String(err)}`);
      await page.screenshot({ path: 'logs/instagram-login-error.png' }).catch(() => {});
      await page.close().catch(() => {});
      await this.close();
      return false;
    }
  }

  // ----------------------------------------------------------------
  // 公開: テキストカード画像を生成して tmp/ に保存 (#33)
  // og:image がない記事の代替画像として使用
  // ----------------------------------------------------------------

  /**
   * グラデーション背景 + テキストオーバーレイの 1080×1080 PNG を生成して返す。
   * 既存の browser コンテキストを使用するため追加ブラウザ起動は不要。
   */
  async generateTextCard(opts: {
    title: string;
    categoryEmoji?: string;
    categoryLabel?: string;
  }): Promise<string | null> {
    if (!this.context) {
      logger.warn('[TextCard] browser context がありません。テキストカード生成をスキップします');
      return null;
    }

    const tmpDir = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const outPath = path.join(tmpDir, `instagram-textcard-${Date.now()}.png`);

    // 1080x1080 グラデーション HTML テンプレート
    const titleEscaped = opts.title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .slice(0, 80);
    const catLabel = opts.categoryEmoji && opts.categoryLabel
      ? `${opts.categoryEmoji}【${opts.categoryLabel}】`
      : '#AIニュース';

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1080px; height: 1080px; overflow: hidden;
    background: linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%);
    font-family: 'Hiragino Sans', 'Yu Gothic', 'Noto Sans JP', sans-serif;
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    width: 900px; padding: 60px;
    background: rgba(255,255,255,0.08);
    border-radius: 24px;
    border: 1px solid rgba(255,255,255,0.15);
  }
  .category {
    font-size: 28px; font-weight: 700; color: #7ec8e3;
    margin-bottom: 32px; letter-spacing: 0.05em;
  }
  .title {
    font-size: 48px; font-weight: 700; line-height: 1.4;
    color: #ffffff; letter-spacing: 0.02em;
  }
  .footer {
    margin-top: 60px; font-size: 22px; color: rgba(255,255,255,0.5);
    letter-spacing: 0.1em;
  }
  .dot { display: inline-block; width: 8px; height: 8px;
    background: #7ec8e3; border-radius: 50%; margin-right: 12px;
    vertical-align: middle; }
</style>
</head>
<body>
<div class="card">
  <div class="category">${catLabel}</div>
  <div class="title">${titleEscaped}</div>
  <div class="footer"><span class="dot"></span>AI News Daily</div>
</div>
</body>
</html>`;

    let page: Page | null = null;
    try {
      page = await this.context.newPage();
      await page.setViewportSize({ width: 1080, height: 1080 });
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500); // フォント描画待ち
      await page.screenshot({ path: outPath, type: 'png' });
      logger.info(`[TextCard] テキストカード生成完了: ${outPath}`);
      return outPath;
    } catch (err) {
      logger.warn(`[TextCard] 生成失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  // ----------------------------------------------------------------
  // 内部: 画像ダウンロード → tmp/ に保存
  // ----------------------------------------------------------------

  private async downloadImage(imageUrl: string): Promise<string | null> {
    // file:// パスはテキストカード生成済みファイル → そのまま返す
    if (imageUrl.startsWith('file://')) {
      const localPath = imageUrl.replace(/^file:\/\//, '');
      if (fs.existsSync(localPath)) {
        logger.info(`[画像] ローカルファイルを使用: ${localPath}`);
        return localPath;
      }
      logger.warn(`[画像] ローカルファイルが見つかりません: ${localPath}`);
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
      if (buf.byteLength > 8 * 1024 * 1024) {
        logger.warn(`画像サイズ超過 (${Math.round(buf.byteLength / 1024)}KB > 8MB) → スキップ`);
        return null;
      }

      const ct = (res.headers['content-type'] as string) || '';
      let ext = 'jpg';
      if      (ct.includes('png'))  ext = 'png';
      else if (ct.includes('webp')) ext = 'jpg'; // Instagram は webp 非対応のため jpg に
      else {
        const urlExt = imageUrl.split('.').pop()?.split('?')[0]?.toLowerCase() ?? '';
        if (['jpg', 'jpeg', 'png'].includes(urlExt)) ext = urlExt === 'jpeg' ? 'jpg' : urlExt;
      }

      const tmpDir = path.join(process.cwd(), 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpPath = path.join(tmpDir, `instagram-img-${Date.now()}.${ext}`);
      fs.writeFileSync(tmpPath, buf);
      logger.info(`画像保存: ${tmpPath} (${Math.round(buf.byteLength / 1024)} KB)`);
      return tmpPath;
    } catch (err) {
      logger.warn(`画像ダウンロード失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ----------------------------------------------------------------
  // 内部: Instagram Web で投稿
  // ----------------------------------------------------------------

  private async postToInstagram(page: Page, text: string, tmpPath: string | null): Promise<void> {
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // 画像なし → Instagram はテキストのみ投稿不可のためスキップ
    if (!tmpPath) {
      logger.warn('Instagram は画像必須のため、画像なし投稿はスキップします');
      throw new Error('Instagram: 画像なし投稿はスキップ');
    }

    // 新規投稿ボタンをクリック（複数セレクターを順番に試す）
    // SPAのレンダリング完了を待つ（2秒では不足する場合がある）
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'logs/instagram-home.png' }).catch(() => {});

    const newPostSelectors = [
      // 現行 Instagram Web（2024〜）: SVG を内包する <a> 親要素をクリック
      'a:has(svg[aria-label="New post"])',
      'a:has(svg[aria-label="新規投稿"])',
      'a:has(svg[aria-label="作成"])',
      'a:has(svg[aria-label="Create"])',
      // aria-label の部分一致
      'a:has(svg[aria-label*="post"])',
      'a:has(svg[aria-label*="post" i])',
      'a:has(svg[aria-label*="作成"])',
      'a:has(svg[aria-label*="新規"])',
      // SVG 直接クリック（フォールバック）
      'svg[aria-label="New post"]',
      'svg[aria-label="新規投稿"]',
      'svg[aria-label="作成"]',
      'svg[aria-label="Create"]',
      'svg[aria-label*="新規"]',
      // data-testid
      '[data-testid="new-post-button"]',
      '[data-testid="new-post-icon"]',
      // リンク形式
      'a[href="/create/style/"]',
      'a[href="/create/"]',
      // テキスト形式
      ':text("新規投稿")',
      ':text("作成")',
    ];

    let clicked = false;
    for (const sel of newPostSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        await el.click();
        logger.info(`Instagram 新規投稿ボタンをクリック: ${sel}`);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // フォールバック: create URL に直接移動してファイル選択を試みる
      logger.warn('新規投稿ボタンが見つかりません。create URL に直接移動します...');
      await page.goto('https://www.instagram.com/create/style/', {
        waitUntil: 'domcontentloaded', timeout: 20000,
      }).catch(() => {});
      await page.waitForTimeout(3000);

      // create ページでもファイル選択が出なければエラー
      const hasFileChooserTrigger = await page.locator(
        'button:has-text("コンピュータから選択"), button:has-text("Select from computer"), ' +
        'input[type="file"], [data-testid="file-upload"]'
      ).first().isVisible({ timeout: 5000 }).catch(() => false);

      if (!hasFileChooserTrigger) {
        await page.screenshot({ path: 'logs/instagram-home.png' }).catch(() => {});
        throw new Error('Instagram 新規投稿ボタンが見つかりません');
      }
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'logs/instagram-step1-after-click.png' }).catch(() => {});
    logger.info('[step1] New post クリック後のスクリーンショット保存');

    // Instagram が「投稿を作成」モーダルを出すまで少し待つ
    // (Post/Reel/Story 選択 or 直接ファイル選択ダイアログ)
    // 「コンピュータから選択」ボタンをクリック → fileChooser
    // input[type="file"] が直接ある場合も対応
    const fileSelectBtnSel = 'button:has-text("コンピュータから選択"), button:has-text("Select from computer"), ' +
      'button:has-text("Select from Gallery"), button:has-text("ギャラリーから選択"), ' +
      '[role="button"]:has-text("コンピュータから選択"), [role="button"]:has-text("Select from computer")';
    const fileInput = page.locator('input[type="file"]').first();
    const hasDirectFileInput = await fileInput.count().then(c => c > 0).catch(() => false);

    if (hasDirectFileInput) {
      await fileInput.setInputFiles(tmpPath);
      logger.info('[step2] 画像ファイルをセット（input直接）');
    } else {
      // "コンピュータから選択" ボタンが表示されるまで待つ（最大15秒）
      const fileBtn = page.locator(fileSelectBtnSel).first();
      const fileBtnVisible = await fileBtn.isVisible({ timeout: 15000 }).catch(() => false);
      logger.info(`[step2] ファイル選択ボタン可視: ${fileBtnVisible}`);
      await page.screenshot({ path: 'logs/instagram-step2-file-dialog.png' }).catch(() => {});

      if (!fileBtnVisible) {
        // ファイル選択ボタンが見えない場合、input[type="file"] を強制的に使う
        const fileInputFallback = page.locator('input[type="file"]').first();
        const inputCount = await fileInputFallback.count();
        logger.info(`[step2] input[type="file"] 数: ${inputCount}`);
        if (inputCount > 0) {
          await fileInputFallback.setInputFiles(tmpPath);
          logger.info('[step2] 画像ファイルをセット（非表示input）');
        } else {
          await page.screenshot({ path: 'logs/instagram-error.png' }).catch(() => {});
          throw new Error('Instagram ファイル選択ボタンも input も見つかりません');
        }
      } else {
        const [fc] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 15000 }),
          fileBtn.click(),
        ]).catch(async (err) => {
          await page.screenshot({ path: 'logs/instagram-error.png' }).catch(() => {});
          throw new Error(`Instagram ファイル選択ダイアログが開きません: ${err}`);
        });
        await fc.setFiles(tmpPath);
        logger.info('[step2] 画像ファイルを選択（filechooser）');
      }
    }
    await page.waitForTimeout(4000);
    await page.screenshot({ path: 'logs/instagram-step3-after-file.png' }).catch(() => {});
    logger.info('[step3] ファイル選択後のスクリーンショット保存');

    // 「次へ」を最大4回クリック（クロップ → フィルター → キャプション）
    // Instagram の「Next」ボタンはbuttonタグではなく styled div のことがある
    // Playwright getByRole + テキストマッチ を優先して使う
    for (let i = 0; i < 4; i++) {
      // 複数の方法を試す
      const nextLocators = [
        page.getByRole('button', { name: 'Next', exact: true }),
        page.getByRole('button', { name: '次へ', exact: true }),
        page.locator('[role="button"]:has-text("Next")').first(),
        page.locator('[role="button"]:has-text("次へ")').first(),
        page.locator(':text-is("Next")').first(),
        page.locator(':text-is("次へ")').first(),
        page.locator('button:has-text("Next"), button:has-text("次へ")').first(),
      ];

      let nextClicked = false;
      for (const btn of nextLocators) {
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          logger.info(`[step4] 「次へ」クリック成功 (${i + 1}/4)`);
          nextClicked = true;
          await page.waitForTimeout(2500);
          await page.screenshot({ path: `logs/instagram-step4-next${i + 1}.png` }).catch(() => {});
          break;
        }
      }
      if (!nextClicked) {
        logger.info(`[step4] 「次へ」ボタンなし (${i + 1}回目) → ループ終了`);
        break;
      }
    }

    await page.screenshot({ path: 'logs/instagram-step5-caption.png' }).catch(() => {});
    logger.info('[step5] キャプション画面のスクリーンショット保存');

    // キャプション入力
    const captionArea = page.locator(
      'div[aria-label="キャプションを入力…"], div[aria-label="Write a caption..."], ' +
      'div[aria-label="キャプション"], div[aria-label="Caption"], ' +
      'textarea[aria-label*="caption"], textarea[aria-label*="キャプション"], ' +
      'div[contenteditable="true"]'
    ).first();

    const captionVisible = await captionArea.isVisible({ timeout: 8000 }).catch(() => false);
    logger.info(`[step5] キャプションエリア可視: ${captionVisible}`);
    if (captionVisible) {
      await captionArea.click();
      await page.keyboard.type(text, { delay: 10 });
      logger.info(`[step5] キャプション入力完了: ${text.length}文字`);
      await page.waitForTimeout(1500);
    }

    // ※ Escape を押すとモーダルが前のステップに戻ることがあるため使わない

    await page.screenshot({ path: 'logs/instagram-step6-before-share.png' }).catch(() => {});
    logger.info('[step6] シェアボタン前のスクリーンショット保存');

    // 「Share」「シェア」— Instagram は button タグでなく styled div のことがある
    // JS evaluate で直接探してクリックする（最も信頼性が高い）
    const jsShareClicked = await page.evaluate(`
      (() => {
        const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
          const text = el.textContent && el.textContent.trim();
          return (text === 'Share' || text === 'シェア') && el.childElementCount === 0;
        });
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            el.click();
            return el.tagName + ':' + (el.textContent ? el.textContent.trim() : '');
          }
        }
        return null;
      })()
    `) as string | null;

    if (jsShareClicked) {
      logger.info(`[step6] Instagram シェアボタンをクリック (JS evaluate: ${jsShareClicked})`);
    } else {
      // フォールバック: Playwright locator
      const shareLocators = [
        page.getByRole('button', { name: 'Share', exact: true }),
        page.getByRole('button', { name: 'シェア', exact: true }),
        page.locator('[role="button"]:has-text("Share")').first(),
        page.locator('[role="button"]:has-text("シェア")').first(),
        page.locator(':text-is("Share")').first(),
        page.locator(':text-is("シェア")').first(),
        page.locator(':text("Share")').first(),
        page.locator('button:has-text("Share"), button:has-text("シェア")').first(),
        page.locator('button:has-text("投稿"), button:has-text("Post")').first(),
      ];

      let shareClicked = false;
      for (const btn of shareLocators) {
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          logger.info('[step6] Instagram シェアボタンをクリック（Playwright locator）');
          shareClicked = true;
          break;
        }
      }
      if (!shareClicked) {
        await page.screenshot({ path: 'logs/instagram-before-share.png' }).catch(() => {});
        throw new Error('Instagram シェアボタンが見つかりません');
      }
    }
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'logs/instagram-after-post.png' }).catch(() => {});
  }

  // ----------------------------------------------------------------
  // 内部: Threads Web で投稿
  // ----------------------------------------------------------------

  private async postToThreadsApp(text: string, tmpPath: string | null): Promise<void> {
    if (!this.context) return;

    const page = await this.context.newPage();

    try {
      await page.goto('https://www.threads.net/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);

      // 投稿エリアをクリック
      const postArea = page.locator(
        'div[role="button"]:has-text("スレッドを開始"), ' +
        'div[role="button"]:has-text("Start a thread"), ' +
        'div[contenteditable="true"]'
      ).first();

      if (!await postArea.isVisible({ timeout: 8000 }).catch(() => false)) {
        await page.screenshot({ path: 'logs/threads-home.png' }).catch(() => {});
        logger.warn('Threads 投稿エリアが見つかりません。スキップします。');
        return;
      }
      await postArea.click();
      await page.waitForTimeout(1000);

      // テキスト入力
      await page.keyboard.type(text, { delay: 15 });
      logger.info(`Threads テキスト入力完了: ${text.length}文字`);
      await page.waitForTimeout(800);

      // 画像添付（ある場合）
      if (tmpPath) {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
          page.locator('[aria-label="画像・動画を追加"], [aria-label="Add image or video"]')
            .first().click().catch(() => {}),
        ]);
        if (fileChooser) {
          await fileChooser.setFiles(tmpPath);
          await page.waitForTimeout(3000);
          logger.info('Threads 画像添付完了');
        }
      }

      // 「投稿」ボタンをクリック
      const postBtn = page.locator('button:has-text("投稿"), button:has-text("Post")').last();
      if (!await postBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await page.screenshot({ path: 'logs/threads-before-post.png' }).catch(() => {});
        logger.warn('Threads 投稿ボタンが見つかりません。スキップします。');
        return;
      }
      await postBtn.click();
      logger.info('Threads 投稿ボタンをクリック');
      await page.waitForTimeout(4000);
      await page.screenshot({ path: 'logs/threads-after-post.png' }).catch(() => {});
      logger.info('Threads 投稿完了');
    } catch (err) {
      logger.warn(`Threads 投稿失敗（スキップ）: ${err instanceof Error ? err.message : String(err)}`);
      await page.screenshot({ path: 'logs/threads-error.png' }).catch(() => {});
    } finally {
      await page.close().catch(() => {});
    }
  }
}
