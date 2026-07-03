/**
 * MicroApps Hub — Note 個別アプリ紹介記事
 *
 * API からアプリ一覧を取得し、日替わりで1本ずつ note に記事投稿する。
 * 偶数日: 無料版訴求記事 / 奇数日: Pro版（買い切り）訴求記事
 *
 * 運用方法:
 *   npm run apps:note           # 今日担当アプリを Note に投稿
 *   npm run apps:note:dry-run   # 投稿内容確認（投稿しない）
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { NotePublisher } from './publisher';
import { logger } from '../utils/logger';
import { loadMicroApps, pickAppByDate, type MicroApp } from '../utils/micro-apps-loader';

const APPS_BASE_URL = 'https://micro-apps-hub-seven.vercel.app';

type Template = 'free' | 'pro';

function pickTemplate(date: Date): Template {
  const jstDay = new Date(date.getTime() + 9 * 60 * 60 * 1000).getUTCDate();
  return jstDay % 2 === 0 ? 'free' : 'pro';
}

async function generateNoteArticle(app: MicroApp, template: Template, client: Anthropic): Promise<{ title: string; body: string }> {
  const url = `${APPS_BASE_URL}/apps/${app.slug}`;
  const proUrl = `${url}/pro`;

  const prompt = template === 'free' ? `
以下のミニアプリの「無料版」を紹介するnote記事を日本語で書いてください。

## アプリ情報
- アプリ名: ${app.title} ${app.emoji}
- カテゴリ: ${app.tag}
- アプリ説明: ${app.description}
- 無料でできること: ${app.freeFeatures.join('、')}
- URL: ${url}

## 記事の構成
1. **導入**（2段落）: 「無料で〇〇できるアプリを見つけた」という発見感
2. **無料でできること**（h2 + 箇条書き）
3. **実際に使ってみた感想**（2〜3段落）
4. **こんな人に無料版がおすすめ**（h2 + 3項目）
5. **さっそく無料で試す**（URLで締め）

## 制約
- Pro版・有料機能には一切触れない
- 800〜1200文字程度、markdown形式
- 「無料」「登録不要」「今すぐ」を自然に使う
- 絵文字を適度に使う
- 最後にURLを必ず入れる: ${url}
` : `
以下のミニアプリの「Pro版（買い切り）」を訴求するnote記事を日本語で書いてください。

## アプリ情報
- アプリ名: ${app.title} ${app.emoji}
- カテゴリ: ${app.tag}
- アプリ説明: ${app.description}
- 無料版の制限: ${app.freeFeatures[0]}まで
- Pro機能: ${app.proFeatures.join('、')}
- 価格: ¥${app.price}（買い切り・永久利用）
- Pro版URL: ${proUrl}

## 記事の構成
1. **導入**（2段落）: 無料版の制限に物足りなさを感じた体験談
2. **Pro版でできること**（h2 + 箇条書き）
3. **買い切りが最強な理由**（h2）: サブスクとの比較
4. **Pro版はこんな人に**（h2 + 3項目）
5. **Pro版を試してみる**（Pro URLで締め）

## 制約
- 「買い切り」「サブスク不要」「一度払えば永久」を強調
- 価格（¥${app.price}）を必ず入れる
- 800〜1200文字程度、markdown形式
- 絵文字を適度に使う
- 最後にURLを必ず入れる: ${proUrl}
`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const body = (response.content[0] as { text: string }).text.trim();
  const title = template === 'free'
    ? `${app.emoji} ${app.title}を無料で試してみた【ミニアプリHub】`
    : `${app.emoji} ${app.title}のPro版が買い切りで最強すぎた【サブスク不要】`;

  return { title, body };
}

export async function postMicroAppToNote(options: { dryRun?: boolean } = {}): Promise<void> {
  const now = new Date();
  const apps = await loadMicroApps();
  const app = pickAppByDate(apps, now);
  const template = pickTemplate(now);

  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY']! });

  logger.info(`[Note/MicroApps] 今日のアプリ: ${app.title} (${apps.length}本中)`);
  logger.info(`[Note/MicroApps] テンプレート: ${template === 'free' ? '無料訴求' : 'Pro訴求'}`);

  const { title, body } = await generateNoteArticle(app, template, client);
  logger.info(`[Note/MicroApps] タイトル: ${title}`);
  logger.info(`[Note/MicroApps] 本文 (先頭200字):\n${body.slice(0, 200)}...`);

  if (options.dryRun) {
    logger.info('[Note/MicroApps] dry-run モード — 投稿しません');
    return;
  }

  const publisher = new NotePublisher({
    email: process.env['NOTE_EMAIL']!,
    password: process.env['NOTE_PASSWORD']!,
  });

  const ok = await publisher.open();
  if (!ok) {
    logger.error('[Note/MicroApps] Note ログイン失敗');
    return;
  }

  const publishedUrl = await publisher.publish(title, body);
  await publisher.close();

  if (publishedUrl) {
    logger.info(`[Note/MicroApps] ✅ 投稿完了: ${publishedUrl}`);
  } else {
    logger.error('[Note/MicroApps] ❌ 投稿失敗');
  }
}

// CLI 実行
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  postMicroAppToNote({ dryRun }).catch(console.error);
}
