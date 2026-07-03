/**
 * 投稿候補メッセージを Claude で品質スコアリングし、上位 N 件を返す。
 *
 * スコア基準 (1〜5):
 *  5 = 公式発表・大手メディア・研究レポート・GitHub 等、価値が高い
 *  4 = 専門ブログ・業界メディア・実用的な解説
 *  3 = ツイート等でも内容が具体的で参考になる
 *  2 = 情報量が薄い・汎用的すぎる
 *  1 = ほぼ価値なし
 */
import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger';

export interface MessageWithUrls {
  body: string;
  urls: string[];
}

export interface ScoredMessage extends MessageWithUrls {
  score: number;
}

/**
 * メッセージリストを品質スコアリングして高スコア順に返す。
 * topN を指定すると上位 N 件だけ返す。
 */
export async function scoreAndSelectMessages(
  anthropic: Anthropic,
  messages: MessageWithUrls[],
  topN: number
): Promise<ScoredMessage[]> {
  if (messages.length === 0) return [];

  // バッチで一度に採点（API コール 1 回）
  const entries = messages
    .map((m, i) => {
      const urlLine = m.urls.join(', ');
      const bodySnippet = m.body.slice(0, 200).replace(/\n/g, ' ');
      return `[${i}] URL: ${urlLine}\n本文抜粋: ${bodySnippet}`;
    })
    .join('\n\n');

  const prompt = `あなたはマーケティング・AI・ビジネス専門の情報キュレーターです。
以下の各メッセージ（URLと本文抜粋）を、マーケターや経営者が読む価値があるかを 1〜5 で採点してください。

【採点基準】
5: 公式発表・大手メディア・研究レポート・有名 OSS/GitHub・実用的な技術解説
4: 専門ブログ・業界メディア・具体的な活用事例
3: ツイートでも内容が具体的で参考になる情報
2: 情報量が薄い・汎用的すぎる・既知の話題の繰り返し
1: ほぼ価値なし・宣伝のみ・関係性が薄い

各メッセージについて、インデックス番号とスコアだけを以下の形式で出力してください:
0:4
1:2
2:5
...

メッセージ一覧:
${entries}`;

  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content[0].type === 'text' ? res.content[0].text.trim() : '';
    const scoreMap = new Map<number, number>();

    for (const line of text.split('\n')) {
      const m = line.match(/^(\d+):(\d)$/);
      if (m) {
        scoreMap.set(parseInt(m[1], 10), parseInt(m[2], 10));
      }
    }

    const scored: ScoredMessage[] = messages.map((msg, i) => ({
      ...msg,
      score: scoreMap.get(i) ?? 3,
    }));

    scored.sort((a, b) => b.score - a.score);
    const selected = scored.slice(0, topN);

    logger.info(
      `[品質スコアリング] ${messages.length} 件 → 上位 ${selected.length} 件を選択` +
      ` (スコア分布: ${[5,4,3,2,1].map(s => `${s}点:${scored.filter(x=>x.score===s).length}件`).join(', ')})`
    );

    return selected;
  } catch (err) {
    logger.warn(`[品質スコアリング] API エラー → 時間順にフォールバック: ${err instanceof Error ? err.message : err}`);
    // エラー時は元の順番で topN 件返す
    return messages.slice(0, topN).map(m => ({ ...m, score: 3 }));
  }
}
