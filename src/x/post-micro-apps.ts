/**
 * MicroApps Hub 自動投稿（施策: ミニアプリ紹介）
 *
 * 21本のミニアプリを毎日ローテーションで紹介し、
 * 無料版と Pro 版の訴求を X に投稿する。
 *
 * 運用方法:
 *   npm run apps:post          # 手動で1件投稿
 *   npm run apps:post:dry-run  # 投稿内容確認（投稿しない）
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { XPoster } from './poster';
import { logger } from '../utils/logger';
import { loadMicroApps, pickAppByDate, type MicroApp } from '../utils/micro-apps-loader';

const APPS_BASE_URL = 'https://micro-apps-hub-seven.vercel.app';

// 配信実績ログ（delivery-dashboard.ts が集計する）
const MICRO_APPS_LOG_FILE = path.join(process.cwd(), 'data', 'micro-apps-post-log.jsonl');

function logMicroAppDelivery(entry: {
  postedAt: string;
  channel: 'x';
  slug: string;
  title: string;
  template: string;
  url: string;
  success: boolean;
}): void {
  try {
    fs.mkdirSync(path.dirname(MICRO_APPS_LOG_FILE), { recursive: true });
    fs.appendFileSync(MICRO_APPS_LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    logger.warn(`[MicroApps] 配信ログ記録失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 24本のアプリ情報（ローテーション用）
// 投稿テンプレート（3種類をローテーション）
// 投稿タイプ: 無料訴求（偶数日）/ Pro訴求（奇数日）
type Template = 'free' | 'pro';

function pickTemplate(date: Date): Template {
  const jstDay = new Date(date.getTime() + 9 * 60 * 60 * 1000).getUTCDate();
  return jstDay % 2 === 0 ? 'free' : 'pro';
}

async function generatePost(app: MicroApp, template: Template, client: Anthropic): Promise<string> {
  const url = `${APPS_BASE_URL}/apps/${app.slug}`;

  const prompts: Record<Template, string> = {
    free: `
      以下のミニアプリの「無料版」紹介ツイートを日本語で書いてください。
      - アプリ名: ${app.title} ${app.emoji}
      - ジャンル: ${app.tag}
      - 無料でできること: ${app.freeFeatures.join('、')}
      - URL: ${url}

      条件:
      - 140文字以内
      - 絵文字を2〜3個使う
      - 「無料」「今すぐ遊べる」「登録不要」のいずれかを使う
      - Pro版には一切触れない（純粋に無料版の魅力だけを伝える）
      - 体験・感情を想起させる文体（「〜してみた」「〜が楽しい」など）
      - URLを末尾に含める
      - ハッシュタグなし
    `,
    pro: `
      以下のミニアプリの「Pro版（買い切り）」訴求ツイートを日本語で書いてください。
      - アプリ名: ${app.title} ${app.emoji}
      - ジャンル: ${app.tag}
      - 価格: ¥${app.price}（買い切り・永久利用）
      - Pro機能: ${app.proFeatures.join('、')}
      - 無料版の制限: ${app.freeFeatures[0]}まで
      - URL: ${url}

      条件:
      - 140文字以内
      - 絵文字を2〜3個使う
      - 「買い切り」「一度払えば永久」「サブスク不要」のいずれかを使う
      - 無料版の制限に軽く触れてからProの解放感を伝える
      - 価格（¥${app.price}）を必ず入れる
      - URLを末尾に含める
      - ハッシュタグなし
    `,
  };

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompts[template] }],
  });

  return (response.content[0] as { text: string }).text.trim();
}

export async function postMicroApp(options: { dryRun?: boolean } = {}) {
  const now = new Date();
  const apps = await loadMicroApps();
  const app = pickAppByDate(apps, now);
  const template = pickTemplate(now);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  logger.info(`[MicroApps] アプリ: ${app.title} / テンプレート: ${template}`);

  const text = await generatePost(app, template, client);
  logger.info(`[MicroApps] 投稿内容:\n${text}`);

  if (options.dryRun) {
    logger.info('[MicroApps] dry-run モード — 実際には投稿しません');
    return { text, app, template };
  }

  const poster = new XPoster({
    email: process.env['X_EMAIL']!,
    password: process.env['X_PASSWORD']!,
    username: process.env['X_USERNAME'],
    phone: process.env['X_PHONE'],
  });
  await poster.open();
  await poster.tweet(text);
  await poster.close();

  logMicroAppDelivery({
    postedAt: new Date().toISOString(),
    channel: 'x',
    slug: app.slug,
    title: app.title,
    template,
    url: `${APPS_BASE_URL}/apps/${app.slug}`,
    success: true,
  });

  logger.info('[MicroApps] ✅ 投稿完了');
  return { text, app, template };
}

// CLI 実行
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  postMicroApp({ dryRun }).catch(console.error);
}
