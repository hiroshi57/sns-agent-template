/**
 * MicroApps Hub — Instagram 個別アプリ紹介投稿
 *
 * API からアプリ一覧を取得し、日替わりで1本ずつ Instagram に投稿する。
 * 偶数日: 無料版訴求 / 奇数日: Pro版（買い切り）訴求
 *
 * 運用方法:
 *   npm run apps:instagram           # 今日担当アプリを Instagram に投稿
 *   npm run apps:instagram:dry-run   # 投稿内容確認（投稿しない）
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { InstagramPoster } from './poster';
import { logger } from '../utils/logger';
import { loadMicroApps, pickAppByDate, type MicroApp } from '../utils/micro-apps-loader';

const APPS_BASE_URL = 'https://micro-apps-hub-seven.vercel.app';

const TAG_HASHTAGS: Record<string, string[]> = {
  'ゲーム':        ['#ミニゲーム', '#ブラウザゲーム', '#無料ゲーム', '#暇つぶし'],
  'パズル':        ['#パズルゲーム', '#脳トレ', '#無料パズル', '#頭の体操'],
  'ボードゲーム':  ['#ボードゲーム', '#対局AI', '#将棋', '#チェス'],
  'トレーニング':  ['#脳トレ', '#学習アプリ', '#習慣化', '#自己啓発'],
  'ツール':        ['#ツール', '#生産性向上', '#効率化', '#仕事術'],
  'ウェルネス':    ['#マインドフルネス', '#メンタルヘルス', '#健康習慣', '#リラックス'],
};

const BASE_HASHTAGS = ['#ミニアプリ', '#無料アプリ', '#買い切り', '#Webアプリ'];

type Template = 'free' | 'pro';

function pickTemplate(date: Date): Template {
  const jstDay = new Date(date.getTime() + 9 * 60 * 60 * 1000).getUTCDate();
  return jstDay % 2 === 0 ? 'free' : 'pro';
}

function buildHashtags(tag: string): string {
  const specific = TAG_HASHTAGS[tag] ?? [];
  return [...BASE_HASHTAGS, ...specific].join(' ');
}

async function generateInstagramCaption(app: MicroApp, template: Template, client: Anthropic): Promise<string> {
  const url = `${APPS_BASE_URL}/apps/${app.slug}`;
  const hashtags = buildHashtags(app.tag);

  const prompt = template === 'free' ? `
以下のミニアプリの「無料版」を紹介するInstagramキャプションを日本語で書いてください。

アプリ名: ${app.title} ${app.emoji}
カテゴリ: ${app.tag}
無料でできること: ${app.freeFeatures.join('、')}
URL: ${url}

条件:
- 400〜600文字以内
- 冒頭1行でフック（「無料で〇〇できる」「今すぐ遊べる」など）
- Pro版・有料機能には一切触れない
- 「無料」「登録不要」「今すぐ」を自然に使う
- 改行多用・絵文字3〜5個
- 末尾にURL: ${url}
- ハッシュタグは含めない
` : `
以下のミニアプリの「Pro版（買い切り）」を訴求するInstagramキャプションを日本語で書いてください。

アプリ名: ${app.title} ${app.emoji}
カテゴリ: ${app.tag}
価格: ¥${app.price}（買い切り・永久利用）
Pro機能: ${app.proFeatures.join('、')}
無料版の制限: ${app.freeFeatures[0]}まで
URL: ${url}

条件:
- 400〜600文字以内
- 冒頭1行でフック（「サブスク不要」「一度払えばずっと使える」など）
- 無料版の制限に軽く触れてから、Proの解放感を伝える
- 「買い切り」「サブスクなし」「永久利用」を自然に使う
- 価格（¥${app.price}）を必ず入れる
- 改行多用・絵文字3〜5個
- 末尾にURL: ${url}
- ハッシュタグは含めない
`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const caption = (response.content[0] as { text: string }).text.trim();
  return `${caption}\n\n${hashtags}`;
}

export async function postMicroAppToInstagram(options: { dryRun?: boolean } = {}): Promise<void> {
  const now = new Date();
  const apps = await loadMicroApps();
  const app = pickAppByDate(apps, now);
  const template = pickTemplate(now);

  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY']! });

  logger.info(`[Instagram/MicroApps] 今日のアプリ: ${app.title} (${apps.length}本中)`);
  logger.info(`[Instagram/MicroApps] テンプレート: ${template === 'free' ? '無料訴求' : 'Pro訴求'}`);

  const caption = await generateInstagramCaption(app, template, client);
  logger.info(`[Instagram/MicroApps] キャプション (先頭200字):\n${caption.slice(0, 200)}...`);

  if (options.dryRun) {
    logger.info('[Instagram/MicroApps] dry-run モード — 投稿しません');
    return;
  }

  const poster = new InstagramPoster({
    username: process.env['INSTAGRAM_USERNAME']!,
    password: process.env['INSTAGRAM_PASSWORD']!,
  });

  const ok = await poster.open();
  if (!ok) {
    logger.error('[Instagram/MicroApps] Instagram ログイン失敗');
    return;
  }

  const imageUrl = process.env['MICRO_APPS_DEFAULT_IMAGE_URL'];
  const result = await poster.post(caption, imageUrl);
  await poster.close();

  if (result) {
    logger.info('[Instagram/MicroApps] ✅ 投稿完了');
  } else {
    logger.error('[Instagram/MicroApps] ❌ 投稿失敗');
  }
}

// CLI 実行
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  postMicroAppToInstagram({ dryRun }).catch(console.error);
}
