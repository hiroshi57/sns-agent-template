/**
 * 意見ツイート（施策C）
 *
 * URL・ハッシュタグなしの「AI専門家の一言」を投稿する。
 *
 * 【なぜ効くか】
 *   X のアルゴリズムは外部リンク付き投稿を抑制する（外部への流出を嫌う）。
 *   URL なしの意見・考察ツイートはその抑制を受けず、100〜500 imp が期待できる。
 *   現在のボット投稿（全部 URL 付き）が avg 1 imp な最大の原因がこれ。
 *
 * 【投稿タイミング】
 *   slot07（朝 07:00）の通常記事投稿完了後に 1 件だけ追加する。
 *   毎日違うテーマを出すため Claude に「今日のお題」を渡す。
 */
import Anthropic from '@anthropic-ai/sdk';
import { XPoster } from './poster';
import { logger } from '../utils/logger';

// 日替わりテーマリスト（曜日・日付で循環）
const OPINION_THEMES = [
  'ChatGPT/LLM の日本企業での実務活用の現実（期待と現実のギャップ）',
  'AI エンジニアに求められるスキルが変わりつつある（プロンプトより問いの立て方）',
  '生成 AI で本当に生産性が上がる仕事とそうでない仕事',
  '「AIに仕事を奪われる」議論で見落とされていること',
  'RAG vs ファインチューニング、どちらを選ぶべきかの判断基準',
  'LLM の「幻覚」を許容できる用途と許容できない用途の境界',
  'AI エージェントが普及した先で人間に残る仕事とは',
  '日本の AI 活用が海外より遅れている本当の理由',
  'プロンプトエンジニアリングは 2 年後も職業として成立しているか',
  'Claude vs GPT-4 vs Gemini、使い分けの個人的な基準',
  'AI ツールを使いこなせる人と使えない人の差は何か',
  'ローカル LLM（Ollama 等）が企業導入で注目される本当の理由',
  'AI 時代の「良いドキュメント」の定義が変わった',
  'コーディング AI（Cursor/Claude Code）で変わった開発者の一日',
];

function pickTheme(date: Date): string {
  const dayOfYear = Math.floor(
    (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86_400_000,
  );
  return OPINION_THEMES[dayOfYear % OPINION_THEMES.length];
}

/**
 * 意見ツイートを Claude で生成する
 */
export async function generateOpinionTweet(anthropic: Anthropic): Promise<string> {
  const theme = pickTheme(new Date());

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `あなたは日本の AI エンジニア/テック専門家です。
以下のテーマについて、X（Twitter）に投稿するための「個人的な意見・考察」を書いてください。

【今日のテーマ】
${theme}

【条件（厳守）】
- 日本語で 130 文字以内
- URL は絶対に含めない
- ハッシュタグは絶対に含めない
- 「ですね」「ます」など自然な口語体
- 「〜だと思う」「〜じゃないかな」など個人の意見として書く
- 具体的な数字・事例・体験談があると良い
- 「AI すごい！」のような薄い内容は避ける
- 賛否が分かれるような、少し挑発的な切り口が理想（炎上狙いではなく考察として）
- 1〜3 文で完結させる

ツイート本文のみを出力してください（前置き・説明なし）:`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return text.trim();
}

/**
 * 意見ツイートを投稿する
 * post-all-slots.ts の slot07 完了後に呼び出す
 */
export async function postOpinionTweet(
  poster: XPoster,
  anthropic: Anthropic,
  opts: { dryRun?: boolean } = {},
): Promise<boolean> {
  const { dryRun = false } = opts;

  logger.info('[opinion] 意見ツイートを生成中...');

  const text = await generateOpinionTweet(anthropic).catch((err) => {
    logger.warn(
      `[opinion] Claude 生成失敗: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });

  if (!text) return false;

  logger.info(`[opinion] 生成: ${text}`);

  if (dryRun) {
    logger.info(`[opinion] [DRY-RUN] 投稿内容: ${text}`);
    return true;
  }

  const ok = await poster.tweet(text); // URL なし・ハッシュタグなし
  if (ok) {
    logger.info('[opinion] ✅ 意見ツイート投稿完了');
  }
  return ok;
}
