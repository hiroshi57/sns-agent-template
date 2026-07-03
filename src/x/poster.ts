import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { logger } from '../utils/logger';

export interface XPosterOptions {
  /** X.com のログインメールアドレス */
  email: string;
  /** X.com のパスワード */
  password: string;
  /** X.com のユーザー名（@なし）— 本人確認チャレンジのフォールバック用 */
  username?: string;
  /** X.com に登録している電話番号（本人確認チャレンジ自動突破用） */
  phone?: string;
  dryRun?: boolean;
}

const SESSION_FILE = path.join(process.cwd(), 'state', 'x-session.json');

/**
 * Playwright を使って X.com にツイートを投稿する
 *
 * セッション管理:
 * 1. state/x-session.json が存在して有効なら headless: false で再利用
 * 2. 期限切れ or 存在しなければ headful で自動ログイン
 *    - jf/onboarding チャレンジ（電話番号確認）も自動突破
 *
 * ページ再利用戦略:
 * - セッション確認で開いたページ (homePage) を閉じずに保持し、
 *   全ツイート投稿でそのページを再利用する
 * - 新規ページを作ると X.com がログインページを返す問題を回避
 */
export class XPoster {
  private opts: XPosterOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  /** セッション確認 + ツイート投稿で共用するページ */
  private homePage: Page | null = null;
  /** 最後の open() 失敗がレート制限によるものかどうか */
  public lastFailureWasRateLimit: boolean = false;
  /** 最後の open() 失敗がアカウント凍結・制限によるものかどうか */
  public lastFailureWasAccountSuspended: boolean = false;

  constructor(opts: XPosterOptions) {
    this.opts = opts;
  }

  /** ブラウザを起動してセッションを確認する */
  async open(): Promise<boolean> {
    if (this.opts.dryRun) return true;

    this.lastFailureWasRateLimit = false;         // 毎回リセット
    this.lastFailureWasAccountSuspended = false;  // 毎回リセット
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

    if (fs.existsSync(SESSION_FILE)) {
      // guest_id のみ（未ログイン）のセッションファイルはスキップ
      try {
        const sess = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        const hasAuthToken = (sess.cookies ?? []).some(
          (c: { name: string }) => ['auth_token', 'ct0', 'twid'].includes(c.name)
        );
        if (hasAuthToken) {
          logger.info('X セッション読み込み中...');
          const ok = await this.connectWithSession();
          if (ok) return true;
          logger.warn('X セッション期限切れ。自動再ログインします...');
        } else {
          logger.info('X セッションが未ログイン状態です。新規ログインします...');
        }
      } catch {
        logger.warn('X セッションファイルの読み込みに失敗しました。新規ログインします...');
      }
    }

    return this.loginAndSave();
  }

  /** ブラウザを閉じる */
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
   * open() 後に確保した Playwright Page を返す（auto-engage 等で外部スクレイプに使用）
   */
  getPage(): Page | null {
    return this.homePage;
  }

  /**
   * 引用ツイートを投稿する
   * X.com の仕様として、ツイート URL をテキスト末尾に含めると引用ツイートとして扱われる
   * @param tweetUrl 引用元ツイートの URL
   * @param comment  引用コメント本文
   */
  async quoteTweet(tweetUrl: string, comment: string): Promise<boolean> {
    return this.tweet(`${comment}\n${tweetUrl}`);
  }

  /**
   * ツイートを投稿する
   * @param text     ツイート本文（URL・ハッシュタグ含む）
   * @param imageUrl 添付する画像の URL（省略可。取得/添付に失敗してもテキストのみで投稿を続行）
   */
  async tweet(text: string, imageUrl?: string): Promise<boolean> {
    if (this.opts.dryRun) {
      logger.info(`[DRY-RUN] ツイート内容:\n${text}`);
      if (imageUrl) logger.info(`[DRY-RUN] 画像: ${imageUrl}`);
      return true;
    }

    if (!this.homePage) {
      logger.error('ブラウザが起動していません。open() を先に呼んでください。');
      return false;
    }

    try {
      await this.postTweet(this.homePage, text, imageUrl);
      logger.info('ツイート投稿完了');
      return true;
    } catch (err) {
      logger.error(`ツイート投稿失敗: ${err instanceof Error ? err.message : String(err)}`);
      await this.homePage.screenshot({ path: 'logs/x-error.png' }).catch(() => {});
      return false;
    }
  }

  // ----------------------------------------------------------------
  // 内部: セッションファイルを使って接続
  // ----------------------------------------------------------------

  private async connectWithSession(): Promise<boolean> {
    // CI 環境 (process.env.CI) では headless: true、ローカルは false
    // X.com は headless Chromium で SideNav を描画しないため通常は false だが、
    // GitHub Actions (ubuntu-latest) には X Window がないため CI では true にする
    const isCI = process.env['CI'] === 'true';
    this.browser = await chromium.launch({
      headless: isCI,
      args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    });
    this.context = await this.browser.newContext({ storageState: SESSION_FILE });

    // このページを homePage として保持し、ツイート投稿にも再利用する
    const page = await this.context.newPage();

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const url = page.url();
    logger.info(`X セッション確認 URL: ${url}`);

    // URL だけでは判定不可 — SideNav_NewTweet_Button の存在で確認
    const hasSideNav = await page.locator('[data-testid="SideNav_NewTweet_Button"]')
      .isVisible({ timeout: 8000 }).catch(() => false);

    if (!hasSideNav) {
      await page.screenshot({ path: 'logs/x-session-expired.png' }).catch(() => {});
      const pageText = await page.textContent('body').catch(() => '') || '';
      const currentUrl = page.url();

      // アカウント凍結・制限の検出
      if (
        currentUrl.includes('account/suspended') ||
        pageText.includes('アカウントが凍結') ||
        pageText.toLowerCase().includes('account has been suspended')
      ) {
        logger.error('❌ X アカウントが凍結または制限されています！手動確認が必要です。');
        logger.error('   https://x.com/i/flow/login を開いて状態を確認してください。');
        this.lastFailureWasAccountSuspended = true;
        await page.close();
        await this.close();
        return false;
      }

      logger.warn('X セッションが期限切れです。自動再ログインします...');
      await page.close();
      await this.close();
      return false;
    }

    await this.context.storageState({ path: SESSION_FILE });
    this.homePage = page;
    logger.info('X.com ログイン済み確認（SideNav 確認）');
    return true;
  }

  // ----------------------------------------------------------------
  // 内部: headful でログイン → セッション保存
  // ----------------------------------------------------------------

  private async loginAndSave(): Promise<boolean> {
    const isCI = process.env['CI'] === 'true';
    logger.info(`X.com に自動ログイン中... ${isCI ? '(CI: headless)' : '(ブラウザが開きます)'}`);
    this.browser = await chromium.launch({
      headless: isCI,
      slowMo: isCI ? 0 : 80,
      args: isCI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    });
    this.context = await this.browser.newContext();

    const page = await this.context.newPage();
    try {
      // トップページから開き、ログインボタンでフォームを表示する
      // （/i/flow/login はモーダル内レンダリングが遅く不安定なため）
      await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // トップページの「ログイン」ボタンをクリック
      const loginPageBtn = page.locator('a[href="/login"], [data-testid="loginButton"]').first();
      if (await loginPageBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await loginPageBtn.click();
        logger.info('トップページのログインボタンをクリック');
        await page.waitForTimeout(3000);
      } else {
        // 直接 /login へ遷移
        await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
      }

      // ── Step 1: メールアドレス / ユーザー名入力 ──
      const usernameSelectors = [
        'input[autocomplete="username"]',
        'input[name="text"]',
        'input[placeholder*="メールアドレス"]',
        'input[placeholder*="email"]',
        'input[type="text"]',
      ];
      let usernameInput = null;
      for (const sel of usernameSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 15000 }).catch(() => false)) {
          usernameInput = loc;
          logger.info(`ユーザー名入力フォーム検出: ${sel}`);
          break;
        }
      }
      if (!usernameInput) {
        await page.screenshot({ path: 'logs/x-login-step1.png' }).catch(() => {});
        throw new Error('ユーザー名入力フォームが見つかりません');
      }
      await usernameInput.fill(this.opts.email);
      await page.waitForTimeout(500);

      // 「次へ」ボタン
      const nextBtnSelectors = [
        '[data-testid="LoginForm_Next_Button"]',
        'button:has-text("次へ")',
        'button:has-text("Next")',
      ];
      for (const sel of nextBtnSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          logger.info(`「次へ」ボタンをクリック: ${sel}`);
          break;
        }
      }
      await page.waitForTimeout(1500);

      // ── Step 2: 追加確認フォーム（ユーザー名 / 電話番号）──
      const extraInput = page.locator('input[data-testid="ocfEnterTextTextInput"]');
      if (await extraInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        logger.info('追加確認フォーム（ユーザー名）を検出');
        await extraInput.fill(this.opts.username || this.opts.email);
        for (const sel of nextBtnSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click();
            break;
          }
        }
        await page.waitForTimeout(1500);
      }

      // ── Step 3: パスワード入力 ──
      const pwLoc = page.locator('input[name="password"]').first();
      await pwLoc.waitFor({ timeout: 10000 });
      await pwLoc.fill(this.opts.password);

      // ログインボタン
      const loginBtnSelectors = [
        '[data-testid="LoginForm_Login_Button"]',
        'button:has-text("ログイン")',
        'button:has-text("Log in")',
      ];
      for (const sel of loginBtnSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          logger.info(`ログインボタンをクリック: ${sel}`);
          break;
        }
      }

      // ログイン後の URL 変化を待つ（チャレンジ含む）
      await page.waitForURL(
        (url) => {
          const s = url.toString();
          return s.includes('x.com/home')
            || /x\.com\/?$/.test(s)
            || s.includes('jf/onboarding')
            || s.includes('/challenge');
        },
        { timeout: 30000 }
      ).catch(() => {
        logger.warn('ログイン後のURL変化待ちがタイムアウト。現在のURL: ' + page.url());
      });

      // ── チャレンジ自動突破 ──
      await this.handleChallenge(page);

      const url = page.url();
      // ログイン成功確認（SideNav が出るか確認）
      const hasSideNav = await page.locator('[data-testid="SideNav_NewTweet_Button"]')
        .isVisible({ timeout: 10000 }).catch(() => false);

      if (!hasSideNav) {
        logger.error(`ログイン失敗。現在のURL: ${url}`);
        await page.screenshot({ path: 'logs/x-login-failed.png' }).catch(() => {});
        const isCI = process.env['CI'] === 'true';
        if (isCI) {
          logger.error('');
          logger.error('=== [CI] X セッション再設定が必要です ===');
          logger.error('  1. ローカルで: npm run x:setup');
          logger.error('  2. state/x-session.json の内容をコピー');
          logger.error('  3. GitHub Secrets > X_SESSION_JSON を更新');
          logger.error('==========================================');
        }
        await page.close().catch(() => {});
        await this.close();
        return false;
      }

      await this.context.storageState({ path: SESSION_FILE });
      logger.info(`X.com ログイン成功。セッション保存: ${SESSION_FILE}`);
      this.homePage = page;
      return true;
    } catch (err) {
      logger.error(`X.com ログインエラー: ${err instanceof Error ? err.message : String(err)}`);
      await page.screenshot({ path: 'logs/x-login-error.png' }).catch(() => {});
      await page.close().catch(() => {});
      await this.close();
      return false;
    }
    // finally で page.close() しない — homePage として保持
  }

  // ----------------------------------------------------------------
  // 内部: jf/onboarding チャレンジを自動突破
  // ----------------------------------------------------------------

  private async handleChallenge(page: Page): Promise<void> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const url = page.url();
      if (!url.includes('jf/onboarding') && !url.includes('/challenge')) break;

      logger.info(`X.com チャレンジ処理 (${attempt + 1}/${MAX_ATTEMPTS}): ${url}`);
      await page.waitForTimeout(1500);

      // ── 課金 / Premium ページ検出 → 即停止 ──
      // jf/onboarding に Premium 購入フローが混入するケースへの安全対策
      // ログインチャレンジページ (jf/onboarding?mode=login) は Premium 宣伝テキストを含むが課金ではない
      // → URL が明示的に premium/subscribe/payment を含む場合のみブロック
      const pageText = await page.textContent('body').catch(() => '') || '';
      const dangerWords = ['premium_sign_up', '¥9', '$8', 'per year', 'per month'];
      const dangerUrl = url.includes('premium/subscribe') || url.includes('payment');
      // jf/onboarding フロー（ログイン・電話番号確認）は誤検知しないよう除外
      const isOnboardingFlow = url.includes('jf/onboarding') || url.includes('signup_phone');
      if (dangerUrl || (!isOnboardingFlow && dangerWords.some(w => pageText.toLowerCase().includes(w.toLowerCase())))) {
        await page.screenshot({ path: 'logs/x-danger-page.png' }).catch(() => {});
        throw new Error('課金/Premium ページを検出しました。安全のため停止します。logs/x-danger-page.png を確認してください。');
      }

      // ── パターン A: ocfEnterTextTextInput（電話番号 / ユーザー名 確認）──
      const challengeInput = page.locator('input[data-testid="ocfEnterTextTextInput"]').first();
      if (await challengeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        const placeholder = (await challengeInput.getAttribute('placeholder') || '').toLowerCase();
        const pageText = (await page.textContent('body').catch(() => '')) || '';
        const isPhone = placeholder.includes('phone') || placeholder.includes('電話')
          || pageText.includes('電話番号') || pageText.includes('phone number');

        if (isPhone && this.opts.phone) {
          logger.info('電話番号チャレンジ: 自動入力します');
          await challengeInput.fill(this.opts.phone);
        } else {
          logger.info('ユーザー名チャレンジ: 自動入力します');
          await challengeInput.fill(this.opts.username || this.opts.email);
        }
        await page.waitForTimeout(500);

        for (const sel of ['[data-testid="ocfEnterTextNextButton"]', '[data-testid="LoginForm_Next_Button"]', 'button:has-text("次へ")', 'button:has-text("Next")']) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click();
            logger.info(`チャレンジ「次へ」クリック: ${sel}`);
            break;
          }
        }
        await page.waitForTimeout(2000);
        continue;
      }

      // ── パターン B: 「続ける」ボタン（jf/onboarding 再認証モーダル）──
      // 「電話番号で続ける」「Appleで続ける」と区別するため exact: true で一致
      // #layers = チャレンジモーダル層（背景の同名ボタンと重複するため #layers に限定）
      const continueBtn = page.locator('#layers').getByRole('button', { name: '続ける', exact: true }).first();
      if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        // レート制限エラーを検出したら即停止
        const layersText = await page.locator('#layers').textContent().catch(() => '') || '';
        if (layersText.includes('一時的に制限') || layersText.includes('temporarily locked') || layersText.includes('Too many')) {
          logger.error('X.com ログインが一時的に制限されています。15〜30分後に再試行してください。');
          await page.screenshot({ path: 'logs/x-rate-limited.png' }).catch(() => {});
          this.lastFailureWasRateLimit = true;
          break;
        }

        // #layers 内の入力欄を埋める（背景ページの input と混同しないよう #layers に限定）
        const inputEl = page.locator('#layers input[autocomplete="username"], #layers input[type="text"], #layers input[type="email"]').first();
        if (await inputEl.isVisible({ timeout: 1000 }).catch(() => false)) {
          const val = await inputEl.inputValue().catch(() => '');
          if (!val) {
            await inputEl.fill(this.opts.email);
            logger.info('メールアドレスを入力 (jf/onboarding モーダル)');
          }
        }
        await continueBtn.click();
        logger.info('「続ける」ボタンをクリック (jf/onboarding)');
        await page.waitForTimeout(2000);

        // 「続ける」後にパスワード入力が出ることがある → #layers 内で探して自動入力
        const pwInput = page.locator('#layers input[name="password"], #layers input[type="password"]').first();
        if (await pwInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          logger.info('パスワード再入力: 自動入力します');
          await pwInput.fill(this.opts.password);
          const loginBtn = page.locator('#layers').getByRole('button', { name: 'ログイン', exact: true }).first();
          const loginBtnEn = page.locator('#layers').getByRole('button', { name: 'Log in', exact: true }).first();
          if (await loginBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await loginBtn.click(); logger.info('ログインボタンをクリック');
          } else if (await loginBtnEn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await loginBtnEn.click(); logger.info('Login button clicked');
          }
          await page.waitForTimeout(2000);
        }
        continue;
      }

      // ── パターン C: 「電話番号で続ける」ボタン（本人確認モーダル）──
      // 「いま何が起こっているかチェック」画面で電話番号認証を求められるケース
      const phoneBtn = page.locator('#layers').getByRole('button', { name: '電話番号で続ける' }).first();
      const phoneBtnEn = page.locator('#layers').getByRole('button', { name: 'Continue with phone' }).first();
      const hasPhoneBtn =
        await phoneBtn.isVisible({ timeout: 2000 }).catch(() => false) ||
        await phoneBtnEn.isVisible({ timeout: 1000 }).catch(() => false);

      if (hasPhoneBtn) {
        logger.info('「電話番号で続ける」ボタンを検出');
        if (await phoneBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await phoneBtn.click();
        } else {
          await phoneBtnEn.click();
        }
        await page.waitForTimeout(2000);

        // 電話番号入力フォームが出たら入力
        const phoneInput = page.locator('#layers input[name="phone_number"], #layers input[type="tel"], #layers input[data-testid="ocfEnterTextTextInput"]').first();
        if (await phoneInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          if (this.opts.phone) {
            logger.info('電話番号を入力します');
            await phoneInput.fill(this.opts.phone);
            await page.waitForTimeout(500);
            // 「続ける」または「次へ」ボタンをクリック
            for (const sel of [
              'button:has-text("続ける")',
              '[data-testid="ocfEnterTextNextButton"]',
              'button:has-text("次へ")',
              'button:has-text("Next")',
              'button:has-text("Continue")',
            ]) {
              const btn = page.locator(sel).first();
              if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btn.click();
                logger.info(`電話番号確認ボタンクリック: ${sel}`);
                break;
              }
            }
            await page.waitForTimeout(3000);
          } else {
            logger.warn('X_PHONE が未設定です。.env に X_PHONE=+8190XXXXXXXX を追加してください。');
            break;
          }
        }
        continue;
      }

      // ── パターン D: 不明なチャレンジ ──
      logger.warn('不明なチャレンジページ。スクリーンショット: logs/x-challenge.png');
      await page.screenshot({ path: 'logs/x-challenge.png' }).catch(() => {});
      break;
    }

    // チャレンジ後のスクリーンショット（デバッグ用）
    await page.screenshot({ path: 'logs/x-after-challenge.png' }).catch(() => {});
  }

  // ----------------------------------------------------------------
  // 内部: 画像ダウンロード → Playwright で添付
  // ----------------------------------------------------------------

  /**
   * 画像 URL から画像をダウンロードして tmp/ に保存し、
   * Playwright の fileChooser 経由でツイート compose ダイアログに添付する。
   * 失敗時は false を返す（投稿自体は続行される）。
   */
  private async attachImage(page: Page, imageUrl: string): Promise<boolean> {
    let tmpPath: string | null = null;
    try {
      logger.info(`画像ダウンロード開始: ${imageUrl.slice(0, 80)}`);

      // ── 画像ダウンロード ──
      const res = await axios.get<ArrayBuffer>(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 12000,
        maxRedirects: 3,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AINewsBot/1.0)' },
      });

      const buf = Buffer.from(res.data);

      // 5MB 超は X がリジェクトするためスキップ
      if (buf.byteLength > 5 * 1024 * 1024) {
        logger.warn(`画像サイズ超過 (${Math.round(buf.byteLength / 1024)}KB > 5MB) → スキップ`);
        return false;
      }

      // 拡張子を Content-Type または URL から判定
      const ct = (res.headers['content-type'] as string) || '';
      let ext = 'jpg';
      if      (ct.includes('png'))  ext = 'png';
      else if (ct.includes('gif'))  ext = 'gif';
      else if (ct.includes('webp')) ext = 'webp';
      else {
        const urlExt = imageUrl.split('.').pop()?.split('?')[0]?.toLowerCase() ?? '';
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(urlExt)) {
          ext = urlExt === 'jpeg' ? 'jpg' : urlExt;
        }
      }

      // tmp/ に保存
      const tmpDir = path.join(process.cwd(), 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      tmpPath = path.join(tmpDir, `tweet-img-${Date.now()}.${ext}`);
      fs.writeFileSync(tmpPath, buf);
      logger.info(`画像保存: ${tmpPath} (${Math.round(buf.byteLength / 1024)} KB)`);

      // ── Playwright で添付 ──
      // 方法1: 隠し input[type="file"] に直接 setInputFiles（最も確実）
      const fileInput = page.locator('input[type="file"][accept*="image"], input[type="file"]').first();
      const inputExists = await fileInput.count() > 0;
      if (inputExists) {
        await fileInput.setInputFiles(tmpPath);
        logger.info('画像添付（input直接セット）');
        // 画像アップロード完了を待つ（プログレスバーが消えるまで最大15秒）
        await page.waitForSelector(
          '[data-testid="attachmentProgressBar"]',
          { state: 'detached', timeout: 15000 }
        ).catch(() => {});
        await page.waitForTimeout(2000);
        logger.info('画像添付完了');
        return true;
      }

      // 方法2: メディアボタンクリック → filechooser イベント
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }),
        (async () => {
          for (const sel of [
            '[data-testid="attachments"]',
            '[aria-label="メディア"]',
            '[aria-label="Media"]',
          ]) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
              await el.click().catch(() => {});
              return;
            }
          }
          throw new Error('メディア添付ボタンが見つかりません');
        })(),
      ]);

      await fileChooser.setFiles(tmpPath);
      await page.waitForTimeout(3000);
      logger.info('画像添付完了（filechooser経由）');
      return true;

    } catch (err) {
      logger.warn(
        `画像添付失敗 → テキストのみで投稿を続行: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    } finally {
      // 一時ファイルは成否に関わらず削除
      if (tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  }

  // ----------------------------------------------------------------
  // 内部: ツイート投稿操作（homePage を再利用）
  // ----------------------------------------------------------------

  private async postTweet(page: Page, text: string, imageUrl?: string): Promise<void> {
    // ホームに遷移（compose ダイアログを完全リセット）
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
      logger.warn(`ホーム遷移エラー（続行）: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Escape で残存 compose を閉じる
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'logs/x-home-nav.png' }).catch(() => {});

    // ── Step 1: 「投稿する」ボタンを押して新しいダイアログを開く ──
    const newTweetBtn = page.locator('[data-testid="SideNav_NewTweet_Button"]').first();
    if (await newTweetBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
      await newTweetBtn.click();
      logger.info('「投稿する」ボタンをクリック');
      // ダイアログが完全に開くまで待つ
      await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
    } else {
      logger.warn('SideNav_NewTweet_Button が見つかりません（スクリーンショット: logs/x-home-nav.png）');
    }

    // ── Step 2: 画像添付（テキスト入力前に行う） ──
    let imageAttached = false;
    if (imageUrl) {
      imageAttached = await this.attachImage(page, imageUrl);
      if (imageAttached) {
        await page.waitForTimeout(500);
      } else {
        // 画像添付失敗後: Escape で残存 filechooser / ダイアログをリセット
        logger.info('画像添付失敗 → テキストのみで投稿します（Escape でDOM状態をリセット）');
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
    }

    // ── Step 3: テキストエリアを探してクリック ──
    const editorSelectors = [
      '[data-testid="tweetTextarea_0"]',
      '[data-testid="tweetTextarea_0RichTextInputContainer"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ];

    let editor = null;
    for (const sel of editorSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 8000 }).catch(() => false)) {
        editor = loc;
        logger.info(`投稿エリア検出: ${sel}`);
        break;
      }
    }

    if (!editor) {
      await page.screenshot({ path: 'logs/x-compose-error.png' }).catch(() => {});
      throw new Error('ツイート入力エリアが見つかりません');
    }

    await editor.click();
    await page.waitForTimeout(500);

    // 既存テキストをクリア
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(100);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);

    // insertText で日本語を直接挿入（IME バイパス・React onChange が確実に発火）
    await page.keyboard.insertText(text);
    await page.waitForTimeout(1000);

    await page.screenshot({ path: 'logs/x-before-post.png' }).catch(() => {});
    logger.info(`投稿直前: ${text.length}文字 / 画像添付: ${imageAttached}`);

    // ── Step 4: 投稿ボタンが有効になるまで待ってからクリック ──
    // X.com はテキスト入力後もバリデーション処理で一時的に disabled になる
    const postBtnSelectors = [
      '[data-testid="tweetButtonInline"]',
      '[data-testid="tweetButton"]',
    ];
    let posted = false;
    for (const sel of postBtnSelectors) {
      const btn = page.locator(sel).first();
      if (!await btn.isVisible({ timeout: 5000 }).catch(() => false)) continue;

      // force: true で aria-disabled を無視してクリック
      // (X.com は画像アップロード中に aria-disabled="true" を維持しビジュアルのみ有効に見せる)
      await btn.click({ force: true });
      logger.info(`投稿ボタンをクリック: ${sel}`);
      posted = true;
      break;
    }

    if (!posted) {
      await page.screenshot({ path: 'logs/x-post-btn-error.png' }).catch(() => {});
      throw new Error('投稿ボタンが見つかりません');
    }

    // ── Step 5: 投稿完了を確認（compose ダイアログが閉じるのを待つ）──
    // 投稿成功 → tweetTextarea_0 が消える / ホームのタイムラインに戻る
    // 投稿失敗 → ダイアログが残ったまま（エラーメッセージが出ることも）
    const closeTimeout = 10000;
    try {
      await page.waitForSelector('[data-testid="tweetTextarea_0"]', {
        state: 'hidden',
        timeout: closeTimeout,
      });
      logger.info('投稿完了確認（compose ダイアログが閉じました）');
    } catch {
      // ダイアログが閉じなかった → エラーメッセージを確認
      const pageText = await page.textContent('body').catch(() => '') || '';
      const errPatterns = [
        'エラーが発生しました',
        'something went wrong',
        'try again',
        'もう一度',
        'ツイートを送信できません',
        'Rate limit',
      ];
      const errMsg = errPatterns.find(p => pageText.toLowerCase().includes(p.toLowerCase()));
      await page.screenshot({ path: 'logs/x-post-verify-fail.png' }).catch(() => {});
      if (errMsg) {
        throw new Error(`投稿失敗（X.com エラー検出: "${errMsg}"）`);
      }
      // エラー文言なし＆ダイアログ残存 → 念のため警告して続行
      logger.warn('compose ダイアログが閉じるのを確認できませんでしたが続行します（logs/x-post-verify-fail.png）');
    }

    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'logs/x-after-post.png' }).catch(() => {});
  }
}
