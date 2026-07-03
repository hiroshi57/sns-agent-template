import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger';

/**
 * Chatwork メッセージ本文に投稿者の個人的な感情・意見が含まれるか Claude で判定する。
 *
 * 改善 (#46): YES/NO バイナリ判定 → 1〜5 スコアに変更し、閾値を設定可能にした。
 *
 * スコア定義:
 *   1 = 完全に客観的（URLのみ、タイトルの引用のみ）
 *   2 = ほぼ客観的（短い中立的コメント付き）
 *   3 = 軽度の主観あり（「便利そう」程度）
 *   4 = 明確な意見あり（「すごい」「おすすめ」など）
 *   5 = 強い感情・意見あり（感嘆符多用、個人的推薦等）
 *
 * デフォルト閾値は 4。PDCA 戦略 or 環境変数で調整可能。
 */

/**
 * 意見スコア閾値（これ以上でフィルタ。低くすると厳しくなる）
 * デフォルト 5: スコア5（感嘆符多用・強い感情）のみフィルタ。
 * スコア4（「すごい」「おすすめ」程度）は通す → スキップ率削減のため緩和。
 */
export function getOpinionThreshold(): number {
  const envVal = parseInt(process.env['OPINION_THRESHOLD'] ?? '5', 10);
  return isNaN(envVal) ? 5 : Math.max(1, Math.min(5, envVal));
}

/**
 * 意見スコアを 1〜5 で返す（1=客観的、5=強い意見）
 * エラー時は 1（フィルタしない方向）を返す
 */
export async function getOpinionScore(
  anthropic: Anthropic,
  messageBody: string
): Promise<number> {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 5,
      messages: [
        {
          role: 'user',
          content: `以下のChatworkメッセージ本文に「投稿者の個人的な感情・意見・主観」がどの程度含まれるかを1〜5で評価してください。

スコア基準:
1 = 客観的（URLのみ、タイトル引用のみ）
2 = ほぼ客観的（短い中立的説明のみ）
3 = 軽い主観あり（「便利そう」「興味深い」程度）
4 = 明確な意見あり（「すごい」「おすすめ」「必見」など）
5 = 強い感情・意見（感嘆符多用・個人的推薦・感情的コメント）

数字のみ（1〜5）を答えてください。

メッセージ本文:
${messageBody.slice(0, 800)}`,
        },
      ],
    });

    const raw = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '1';
    const score = parseInt(raw, 10);
    return isNaN(score) ? 1 : Math.max(1, Math.min(5, score));
  } catch (err) {
    logger.warn(`[意見フィルタ] スコア判定エラー → 0でパス: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * 後方互換: hasPersonalOpinion（既存コードから呼び出される）
 * 内部で getOpinionScore を使いスコア >= 閾値 のみ true を返す
 */
export async function hasPersonalOpinion(
  anthropic: Anthropic,
  messageBody: string
): Promise<boolean> {
  const score = await getOpinionScore(anthropic, messageBody);
  const threshold = getOpinionThreshold();
  const hasOpinion = score >= threshold;

  if (hasOpinion) {
    logger.info(
      `[意見フィルタ] スキップ（スコア=${score} >= 閾値=${threshold}）: ` +
      `${messageBody.slice(0, 60).replace(/\n/g, ' ')}...`
    );
  } else if (score >= 3) {
    logger.info(`[意見フィルタ] 通過（スコア=${score} < 閾値=${threshold}）: 軽い主観あり`);
  }

  return hasOpinion;
}
