/**
 * note SEO 月次アフィリエイト記事（施策G）
 *
 * 毎月 1 日に「【YYYY年M月版】AI ガジェット おすすめランキング」記事を note に公開。
 *
 * 【なぜ note なのか】
 *   - note の記事は Google に インデックスされ、検索流入が溜まっていく（複利効果）
 *   - note 記事内のリンクはクリック可能（X では URL が短縮されクリックされにくい）
 *   - 「AI ガジェット おすすめ 2026」などで検索流入を狙える
 *   - 購入意図の高い読者が note 記事を経由して楽天に流入 → コンバージョン率高
 *
 * 【記事構成】
 *   タイトル: 【2026年7月版】AIエンジニアが本当に使ってるガジェット TOP3（楽天おすすめ）
 *   本文:
 *     ・導入（選定基準・筆者について）
 *     ・各商品の詳細レビュー + 楽天リンク
 *     ・まとめ
 *     ・SEO ハッシュタグ
 *
 * 【PM2 cron】
 *   毎月 1 日 10:00 JST = UTC 01:00 → '0 1 1 * *'
 *
 * 【関連】
 *   公開後に data/note-affiliate-article.json に URL を書き込み、
 *   施策E（run-note-cta.ts）がこの URL を参照してツイートで誘導する。
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { NotePublisher } from '../note/publisher';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

// 公開済み記事 URL キャッシュ（施策E がここを参照する）
const ARTICLE_CACHE_FILE = path.join(process.cwd(), 'data', 'note-affiliate-article.json');

interface AffiliateProduct {
  id: string;
  name: string;
  category: string;
  affiliateUrl: string;
  price: number;
  rating: number;
  reviewCount: number;
  highlight: string;
  tags: string[];
  disabled?: boolean;
}

function loadProducts(): AffiliateProduct[] {
  const raw = fs.readFileSync(
    path.join(process.cwd(), 'data', 'affiliate-products.json'),
    'utf-8',
  );
  const data = JSON.parse(raw) as { products: AffiliateProduct[] };
  return data.products.filter((p) => !p.disabled).slice(0, 3);
}

/**
 * SEO 最適化された note 記事を Claude で生成する
 */
async function generateSeoArticle(
  anthropic: Anthropic,
  products: AffiliateProduct[],
  month: string, // "2026年7月"
): Promise<{ title: string; body: string }> {
  const productInfo = products
    .map(
      (p, i) =>
        `【${i + 1}位】${p.name}
価格: ¥${p.price.toLocaleString()}
カテゴリ: ${p.category}
評価: ${p.rating} / 5.0（レビュー ${p.reviewCount}件）
ポイント: ${p.highlight}
購入リンク: ${p.affiliateUrl}
タグ: ${p.tags.join(', ')}`,
    )
    .join('\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: `あなたは AI ガジェット専門のブロガーです。
以下の商品情報をもとに、note 用の SEO 記事を書いてください。

【対象月】${month}

【掲載商品】
${productInfo}

【記事の要件】
タイトル形式: 【${month}版】AIエンジニアが実際に使うガジェット おすすめランキング TOP${products.length}（楽天）

本文構成:
1. 導入（200字程度）
   - 「こんな人に読んでほしい」
   - 選定基準（実際の使用感・コスパ・AI 活用との相性）

2. 各商品のレビュー（各300〜400字）
   - 商品名と価格
   - ここが良い（3点）
   - こんな人に向いている
   - 楽天リンク（Markdown 形式: [商品名を楽天で見る](affiliateUrl)）

3. まとめ（100字程度）

4. SEO タグ（# 記法で 5〜7 個）
   例: #AIガジェット #楽天 #おすすめ #生産性 #テレワーク #AI #ガジェット

【注意】
- 正直なレビュー調で書く（「最高！」ではなく「〜な人に向いている」）
- 楽天リンクは Markdown リンク形式 [テキスト](URL) で必ず含める
- 各見出しは ## を使う
- タイトルと本文を分けて出力すること

出力形式:
---TITLE---
（タイトルのみ）
---BODY---
（本文のみ）
---END---`,
      },
    ],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';

  const titleMatch = raw.match(/---TITLE---\s*([\s\S]*?)---BODY---/);
  const bodyMatch = raw.match(/---BODY---\s*([\s\S]*?)---END---/);

  const title = titleMatch ? titleMatch[1].trim() : `【${month}版】AI ガジェット おすすめランキング TOP${products.length}`;
  const body = bodyMatch ? bodyMatch[1].trim() : raw;

  return { title, body };
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const forceRun = process.argv.includes('--force') || process.env['FORCE_SEO_MONTHLY'] === 'true';

  // 現在の月を取得（JST）
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const month = `${now.getUTCFullYear()}年${now.getUTCMonth() + 1}月`;

  // ── 当月公開済みチェック（--force で強制実行可） ──
  if (!forceRun && fs.existsSync(ARTICLE_CACHE_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(ARTICLE_CACHE_FILE, 'utf-8')) as {
        month?: string;
        url?: string;
        publishedAt?: string;
      };
      if (cache.month === month && cache.url) {
        logger.info(
          `[note-seo] ${month} 分は公開済みです（${cache.url}）。スキップします。`,
        );
        logger.info('[note-seo] 強制実行する場合は --force または FORCE_SEO_MONTHLY=true を使用してください。');
        process.exit(0);
      }
    } catch { /* キャッシュ読み込み失敗時は続行 */ }
  }

  logger.info(`=== note SEO 月次記事生成開始: ${month} (dryRun=${dryRun}) ===`);

  const products = loadProducts();
  logger.info(`対象商品: ${products.map((p) => p.name).join(', ')}`);

  const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

  // 記事生成
  logger.info('Claude で SEO 記事を生成中...');
  const { title, body } = await generateSeoArticle(anthropic, products, month);

  logger.info(`タイトル: ${title}`);
  logger.info(`本文（先頭300字）: ${body.slice(0, 300)}...`);

  // note に投稿
  const publisher = new NotePublisher({
    email: requireEnv('NOTE_EMAIL'),
    password: requireEnv('NOTE_PASSWORD'),
    dryRun,
  });

  if (!dryRun) {
    const opened = await publisher.open();
    if (!opened) {
      logger.error('note へのログインに失敗しました');
      process.exit(1);
    }
  }

  try {
    const articleUrl = await publisher.publish(title, body);

    if (articleUrl) {
      logger.info(`✅ note 記事公開完了: ${articleUrl}`);

      // 施策E（run-note-cta.ts）が参照するキャッシュファイルに保存
      const cache = {
        url: articleUrl,
        title,
        publishedAt: new Date().toISOString(),
        month,
      };
      fs.mkdirSync(path.dirname(ARTICLE_CACHE_FILE), { recursive: true });
      fs.writeFileSync(ARTICLE_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
      logger.info(`URL キャッシュ保存: ${ARTICLE_CACHE_FILE}`);
      logger.info('👉 施策E（note 誘導ツイート）は次回の水・金曜に自動投稿されます');
    } else {
      logger.error('note 記事の公開に失敗しました');
      process.exit(1);
    }
  } finally {
    await publisher.close();
  }

  logger.info('=== note SEO 月次記事完了 ===');
}

main().catch((err) => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
