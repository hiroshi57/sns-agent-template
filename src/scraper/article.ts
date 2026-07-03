import axios from 'axios';
import * as cheerio from 'cheerio';
import { maskPiiByPattern } from '../utils/pii-filter';
import { logger } from '../utils/logger';

/**
 * レスポンスの Content-Type / meta charset からエンコーディングを判定し、
 * 必要なら Buffer → UTF-8 文字列に変換する。
 * Shift-JIS / EUC-JP を扱う日本語サイト（ITmedia 等）向け。
 */
function decodeResponseBody(data: Buffer | string, contentType: string): string {
  if (typeof data === 'string') return data;

  // Content-Type ヘッダーから charset を探す
  const ctMatch = contentType.match(/charset=([^\s;]+)/i);
  const charset = ctMatch ? ctMatch[1].toLowerCase() : '';

  if (charset.includes('shift') || charset.includes('sjis') || charset === 'x-sjis') {
    return new TextDecoder('shift_jis').decode(data);
  }
  if (charset.includes('euc') && charset.includes('jp')) {
    return new TextDecoder('euc-jp').decode(data);
  }

  // ヘッダーに charset がない場合は生 HTML の先頭で meta charset を確認
  const head = data.slice(0, 2048).toString('ascii');
  if (/charset=["']?shift.?jis/i.test(head) || /charset=["']?x-sjis/i.test(head)) {
    return new TextDecoder('shift_jis').decode(data);
  }
  if (/charset=["']?euc-jp/i.test(head)) {
    return new TextDecoder('euc-jp').decode(data);
  }

  // デフォルトは UTF-8
  return new TextDecoder('utf-8').decode(data);
}

export interface ArticleContent {
  url: string;
  title: string;
  summary: string;       // OGP description または先頭テキスト
  thumbnailUrl: string;  // OGP image URL
  body: string;          // 本文テキスト
  isValid: boolean;      // URL が有効かどうか
  error?: string;
}

// 以下のドメインは Bot ブロックで本文取得不可 → Chatwork メッセージ本文をコンテンツとして使用
const SKIP_DOMAINS = [
  'x.com',
  'twitter.com',
  'linkedin.com',        // Bot ブロック（ログイン必須）
  'instagram.com',       // Bot ブロック（ログイン必須）
  'facebook.com',        // Bot ブロック（ログイン必須）
];

/**
 * URL が Bot ブロック対象のドメインか判定する
 */
export function isSkippableDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return SKIP_DOMAINS.includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Chatwork メッセージ本文から ArticleContent を生成する
 * ＜共有＞／[info]／[To:] など Chatwork 固有の記法をすべて除去する
 */
export function buildFromMessageBody(
  url: string,
  messageBody: string
): ArticleContent {
  const cleaned = messageBody
    // 全角山括弧タグ: ＜共有＞ ＜返信＞ など
    .replace(/＜[^＞]+＞/g, '')
    // 半角タグ: [info][/info] [To:xxxx] [返信 to=xxxx] など
    .replace(/\[info\]|\[\/info\]/gi, '')
    .replace(/\[title\]|\[\/title\]/gi, '')
    .replace(/\[To:\d+\][^\]]*\]/g, '')
    .replace(/\[返信\s+to=\S+\s+mid=\S+\]/g, '')
    .replace(/\[引用[^\]]*\][\s\S]*?\[\/引用\]/g, '')
    .replace(/\[code\][\s\S]*?\[\/code\]/gi, '')
    .replace(/\[picon:\d+\]/g, '')
    .replace(/\[piconname:\d+\]/g, '')
    // URL 除去（引数の url 含む全 URL）
    .replace(/https?:\/\/\S+/g, '')
    // 連続空白・空行を整理
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = cleaned.split('\n').filter((l) => l.trim());
  // パターンベースの PII 除去（メール・電話番号など）を Chatwork 本文にも適用
  const title = maskPiiByPattern(lines[0]?.trim() || url);
  const body = maskPiiByPattern(lines.join('\n').trim());

  return {
    url,
    title,
    summary: body.slice(0, 100),
    thumbnailUrl: '',
    body,
    isValid: true,
  };
}

/** invalid 時に返す共通の空コンテンツ */
function invalidArticle(url: string, error: string): ArticleContent {
  return { url, title: '', summary: '', thumbnailUrl: '', body: '', isValid: false, error };
}

/**
 * URL を検証しつつ記事コンテンツを取得する。
 *
 * HEAD → GET の二重リクエストをやめて GET 1本に統一。
 * HEAD は405を返すサーバや内容と異なるステータスを返すサーバで
 * 誤 invalid 判定が発生するため廃止した。
 */
export async function fetchArticle(url: string): Promise<ArticleContent> {
  logger.info(`記事取得開始: ${url}`);

  let html: string;
  try {
    // arraybuffer で受け取り、Content-Type の charset に応じてデコードする
    // （Shift-JIS / EUC-JP を返す日本語サイト向け）
    const res = await axios.get<ArrayBuffer>(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; ChatworkAutomation/1.0; +https://github.com)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      responseType: 'arraybuffer',
      // 4xx / 5xx もレスポンスとして受け取り、下で判定する
      validateStatus: (s) => s < 600,
    });

    if (res.status >= 400) {
      logger.warn(`HTTP ${res.status}: ${url}`);
      return invalidArticle(url, `HTTP ${res.status}`);
    }

    const contentType = (res.headers['content-type'] as string) || '';
    html = decodeResponseBody(Buffer.from(res.data), contentType);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`記事取得失敗: ${url} — ${message}`);
    return invalidArticle(url, message);
  }

  // ----- HTML パース -----
  const $ = cheerio.load(html);

  // ── タイトル（多段フォールバック）──
  const title = (
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('meta[name="twitter:title"]').attr('content')?.trim() ||
    $('h1').first().text().trim() ||
    $('title').text().trim() ||
    ''
  ).slice(0, 200);

  // ── サムネイル ──
  const thumbnailUrl = (
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[property="og:image:secure_url"]').attr('content') ||
    ''
  ).trim();

  // ── 本文テキスト（article > main > body の順で優先） ──
  const bodyEl =
    $('article').length ? $('article') :
    $('main').length    ? $('main')    :
    $('body');
  bodyEl.find(
    'script, style, nav, header, footer, aside, ' +
    '.ad, .banner, .sidebar, .menu, .nav, .footer, ' +
    '[class*="ad-"], [id*="ad-"], [class*="cookie"]'
  ).remove();
  const body = bodyEl.text().replace(/\s+/g, ' ').trim().slice(0, 5000);

  // ── 概要（多段フォールバック：OGP → meta desc → 最初の <p> → 本文先頭） ──
  const ogDesc =
    $('meta[property="og:description"]').attr('content')?.trim() ||
    $('meta[name="description"]').attr('content')?.trim() ||
    $('meta[name="twitter:description"]').attr('content')?.trim() ||
    '';

  // og:description が短すぎる場合は最初の段落 or 本文先頭で補完
  let summary: string;
  if (ogDesc.length >= 30) {
    summary = ogDesc;
  } else {
    // <p> タグから最初の意味のある段落を取得
    let firstPara = '';
    $('p').each((_, el) => {
      const txt = $(el).text().replace(/\s+/g, ' ').trim();
      if (txt.length >= 30 && !firstPara) firstPara = txt.slice(0, 200);
    });
    summary = firstPara || body.slice(0, 200) || ogDesc;
  }

  logger.info(`記事取得完了: "${title.slice(0, 40)}" / summary:${summary.length}文字`);

  // タイトルも概要も取れなかった場合のみ isValid: false
  if (!title && !summary) {
    return invalidArticle(url, 'タイトル・概要の取得に失敗');
  }

  return { url, title, summary, thumbnailUrl, body, isValid: true };
}
