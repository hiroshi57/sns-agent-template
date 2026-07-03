/**
 * SEO アフィリエイト記事 Note 一括公開スクリプト
 *
 * docs/seo-content/ の Markdown 記事を読み込み、
 * note.com に順番に公開する。
 *
 * 使い方:
 *   npm run note:publish-seo               # 全3本を公開
 *   npm run note:publish-seo -- --dry-run  # 内容確認のみ（投稿しない）
 *   npm run note:publish-seo -- --file headphone  # 1本だけ指定
 *
 * 公開後に X 投稿文（docs/seo-content/x-posts.md）の
 * [NOTE_URL_*] を置き換えたテキストをコンソールに表示する。
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { NotePublisher } from './publisher';
import { markdownToNote } from '../utils/markdown-to-note';
import { logAnalytics } from '../utils/analytics-logger';
import { logger } from '../utils/logger';

// ----------------------------------------------------------------
// 記事定義（順番 = 投稿順）
// ----------------------------------------------------------------

interface ArticleDef {
  key: string;           // --file オプションで指定するキー
  file: string;          // docs/seo-content/ からの相対パス
  xPostIndex: number;    // x-posts.md の [NOTE_URL_*] の番号
}

const ARTICLES: ArticleDef[] = [
  {
    key: 'headphone',
    file: 'docs/seo-content/note-headphone-review.md',
    xPostIndex: 1,
  },
  {
    key: 'pc',
    file: 'docs/seo-content/note-pc-macbook-gift.md',
    xPostIndex: 2,
  },
  {
    key: 'monitor',
    file: 'docs/seo-content/note-monitor-guide.md',
    xPostIndex: 3,
  },
];

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`);
  return val;
}

/** X 投稿文の [NOTE_URL_N] を実際の URL に差し替えて表示 */
function printXPost(index: number, noteUrl: string): void {
  const xPostsFile = path.join(process.cwd(), 'docs/seo-content/x-posts.md');
  if (!fs.existsSync(xPostsFile)) return;

  const content = fs.readFileSync(xPostsFile, 'utf-8');
  const placeholder = `[NOTE_URL_${index}]`;

  // 該当投稿ブロックを探して表示
  const blockRegex = /```([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  const blocks: string[] = [];
  while ((match = blockRegex.exec(content)) !== null) {
    if (match[1].includes(placeholder)) {
      blocks.push(match[1].replace(placeholder, noteUrl).trim());
    }
  }

  if (blocks.length > 0) {
    logger.info(`\n✅ X 投稿文（投稿②-${index}）:`);
    logger.info('─'.repeat(50));
    logger.info(blocks[0]);
    logger.info('─'.repeat(50));
  }
}

/** x-posts.md の [NOTE_URL_N] を実際の URL に上書き保存 */
function updateXPostsFile(updates: Record<number, string>): void {
  const xPostsFile = path.join(process.cwd(), 'docs/seo-content/x-posts.md');
  if (!fs.existsSync(xPostsFile)) return;

  let content = fs.readFileSync(xPostsFile, 'utf-8');
  for (const [index, url] of Object.entries(updates)) {
    content = content.split(`[NOTE_URL_${index}]`).join(url);
  }
  fs.writeFileSync(xPostsFile, content, 'utf-8');
  logger.info(`\n📝 x-posts.md を更新しました: ${xPostsFile}`);
}

// ----------------------------------------------------------------
// メイン
// ----------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileFilter = args.find(a => a.startsWith('--file='))?.replace('--file=', '')
    || (args.includes('--file') ? args[args.indexOf('--file') + 1] : null);

  logger.info('=== Note SEO 記事 一括公開 ===');
  if (dryRun) logger.info('[DRY-RUN] 実際の公開はスキップされます');

  // 対象記事を絞り込み
  const targets = fileFilter
    ? ARTICLES.filter(a => a.key === fileFilter)
    : ARTICLES;

  if (targets.length === 0) {
    logger.error(`--file "${fileFilter}" に一致する記事がありません。`);
    logger.info(`有効なキー: ${ARTICLES.map(a => a.key).join(', ')}`);
    process.exit(1);
  }

  logger.info(`対象記事: ${targets.map(a => a.key).join(', ')} (${targets.length}本)`);

  // Note パブリッシャー初期化
  const publisher = new NotePublisher({
    email: requireEnv('NOTE_EMAIL'),
    password: requireEnv('NOTE_PASSWORD'),
    dryRun,
  });

  if (!dryRun) {
    const opened = await publisher.open();
    if (!opened) {
      logger.error('Note ブラウザ起動に失敗しました。');
      logger.info('→ npm run note:setup を実行してセッションを更新してください。');
      process.exit(1);
    }
  }

  const publishedUrls: Record<number, string> = {};
  let successCount = 0;

  try {
    for (const article of targets) {
      const filePath = path.join(process.cwd(), article.file);

      if (!fs.existsSync(filePath)) {
        logger.warn(`ファイルが見つかりません: ${filePath} → スキップ`);
        continue;
      }

      const markdown = fs.readFileSync(filePath, 'utf-8');
      const { title, body } = markdownToNote(markdown);

      logger.info(`\n${'─'.repeat(60)}`);
      logger.info(`[${article.key}] 公開開始`);
      logger.info(`タイトル: ${title}`);
      logger.info(`本文: ${body.length}文字`);

      if (dryRun) {
        logger.info(`[DRY-RUN] 本文プレビュー:\n${body.slice(0, 300)}...\n`);
        successCount++;
        // dry-run では仮URLを設定
        const dummyUrl = `https://note.com/your_account/n/dryrun-${article.key}`;
        publishedUrls[article.xPostIndex] = dummyUrl;
        printXPost(article.xPostIndex, dummyUrl);
        continue;
      }

      // 投稿（最大3回リトライ）
      let noteUrl: string | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        noteUrl = await publisher.publish(title, body);
        if (noteUrl) break;
        if (attempt < 3) {
          logger.warn(`投稿失敗 (試行 ${attempt}/3)。5秒後にリトライ...`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      if (noteUrl) {
        successCount++;
        publishedUrls[article.xPostIndex] = noteUrl;
        logger.info(`✅ [${article.key}] 公開成功`);
        logger.info(`📎 Note URL: ${noteUrl}`);
        printXPost(article.xPostIndex, noteUrl);
      } else {
        logger.error(`❌ [${article.key}] 公開失敗`);
      }

      logAnalytics({
        postedAt: new Date().toISOString(),
        slot: 'note_daily',
        platform: 'note',
        theme: 'affiliate_ranking',
        source: `seo-content:${article.key}`,
        url: noteUrl ?? 'https://note.com',
        title,
        imageAttached: false,
        success: noteUrl !== null,
        contentLength: body.length,
      });

      // 記事間に5秒待機（連続投稿を避ける）
      if (targets.indexOf(article) < targets.length - 1 && !dryRun) {
        logger.info('次の記事まで5秒待機...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  } finally {
    if (!dryRun) await publisher.close();
  }

  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`=== 完了: ${successCount}/${targets.length} 本公開 ===`);

  if (successCount > 0 && !dryRun) {
    logger.info('\n📌 次のステップ:');
    logger.info('  1. Note でそれぞれの記事URLを確認する');
    logger.info('  2. docs/seo-content/x-posts.md の [NOTE_URL_*] を実際の URL に置き換える');
    logger.info('  3. X 投稿文を各スロットに投稿する（slot07/slot11/slot14）');
    logger.info('  4. Day 7 に Search Console でインプレ数を確認する');
    logger.info('\n  ＊アフィリエイトリンク（amzn.to/YOUR_LINK_*）も忘れずに実際のリンクに差し替えてください');
  }
}

main().catch(err => {
  logger.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
