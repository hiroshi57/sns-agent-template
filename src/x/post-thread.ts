/**
 * スレッド投稿（施策B）
 *
 * 1記事を「導入 → 詳細 → 所感」の3ツイートスレッドで投稿する。
 * スレッドは孤立投稿より X アルゴリズムの分配が優遇されやすい。
 *
 * 使い方（slot07 の最初の記事をスレッドにする場合）:
 *   poster.thread(await buildThreadTweets(article, anthropic))
 *
 * 単発ツイートとの使い分け:
 *   - 重要度が高い記事（例: OpenAI 新モデル発表）→ スレッド
 *   - 通常の AI ニュース → 単発ツイート
 */
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';

export interface ThreadArticle {
  title: string;
  url: string;
  body: string;
  source?: string;
}

export interface ThreadTweets {
  tweets: string[];
}

/**
 * 記事から 3 ツイートスレッドを生成する
 *
 * 構成:
 *   Tweet 1: 🔥 ヘッドライン + URL（インパクト重視・フック）
 *   Tweet 2: 📌 ポイント解説（背景・技術的詳細・数字）
 *   Tweet 3: 💡 日本視点の所感（業界インパクト・実務への影響）
 */
export async function buildThreadTweets(
  article: ThreadArticle,
  anthropic: Anthropic,
): Promise<string[]> {
  const bodySnippet = article.body.slice(0, 1000);

  const prompt = `あなたは日本の AI 専門家です。以下の記事を X（Twitter）の 3 ツイートスレッドにしてください。

【記事タイトル】
${article.title}

【記事URL】
${article.url}

【記事本文（抜粋）】
${bodySnippet}

【スレッド構成と各ツイートの条件】

ツイート1（フック）:
- 絵文字1個＋ヘッドライン
- 「なぜ重要か」を1文で
- URL を必ず含める
- 140文字以内

ツイート2（詳細）:
- 📌 で始める
- 3〜4点のポイントを「・」で箇条書き
- 数字・技術詳細を入れる
- ハッシュタグなし
- 140文字以内

ツイート3（日本視点の所感）:
- 💡 で始める
- 日本の業界・ビジネスへの具体的な影響
- 個人の意見・考察を1〜2文
- 末尾に関連ハッシュタグ 2〜3個（#AI #LLM #生成AI 等から選択）
- 140文字以内

【出力形式】
---TWEET1---
（ツイート1の内容）
---TWEET2---
（ツイート2の内容）
---TWEET3---
（ツイート3の内容）
---END---

注意: 区切り文字（---TWEET1--- 等）以外に余計な文字を含めないこと。`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';

  // パース: ---TWEET1--- 〜 ---TWEET2--- の間を抽出
  const tweets: string[] = [];
  const pattern = /---TWEET(\d+)---([\s\S]*?)(?=---TWEET\d+---|---END---)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const tweet = match[2].trim();
    if (tweet) tweets.push(tweet);
  }

  if (tweets.length === 0) {
    // パース失敗時のフォールバック: シンプルな単発ツイートを返す
    logger.warn('[post-thread] スレッドパース失敗。フォールバックで単発ツイートを使用します。');
    return [`${article.title}\n\n${article.url}`];
  }

  logger.info(`[post-thread] スレッド生成完了: ${tweets.length}件`);
  tweets.forEach((t, i) => logger.info(`  [${i + 1}] ${t.slice(0, 80)}...`));

  return tweets;
}

/**
 * スレッド投稿ユーティリティ（XPoster.thread() のラッパー）
 * 生成→投稿を一括で行う
 */
export async function postThread(
  poster: { thread(tweets: string[]): Promise<boolean> },
  article: ThreadArticle,
  anthropic: Anthropic,
  opts: { dryRun?: boolean } = {},
): Promise<boolean> {
  const { dryRun = false } = opts;

  logger.info(`[post-thread] スレッド生成開始: ${article.title.slice(0, 60)}`);
  const tweets = await buildThreadTweets(article, anthropic);

  if (dryRun) {
    logger.info('[post-thread] [DRY-RUN] スレッド内容:');
    tweets.forEach((t, i) => logger.info(`  [${i + 1}] ${t}`));
    return true;
  }

  return poster.thread(tweets);
}
