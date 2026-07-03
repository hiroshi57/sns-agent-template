import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger';

/**
 * 記事タイトルと本文から500文字以内の本文要約を生成する（Claude Haiku）
 * Forte.AI の記事本文として掲載する用途。
 */
export async function generateSummaryBody(
  anthropic: Anthropic,
  title: string,
  body: string
): Promise<string> {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [
        {
          role: 'user',
          content: `以下の記事タイトルと本文を500文字以内の日本語で要約してください。
ルール:
- 必ず日本語のみで出力する
- 記事が英語（または他の外国語）の場合は、まず内容を日本語に翻訳してから要約する
- 日本語の記事と同じように、読者がすらすら読める自然で読みやすい文章にする
- 500文字以内で必ず完結させる
- 本文が少ない場合はタイトルから推測して書く
- 説明・謝罪・前置きなし。要約本文だけ出力する

タイトル: ${title}
本文（先頭2000文字）: ${body.slice(0, 2000)}`,
        },
      ],
    });
    const raw = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    const text = raw
      .replace(/^#+\s.*\n?/gm, '')
      .replace(/^\s*\n/gm, '')
      .trim();
    logger.info(`本文要約生成完了: ${text.length}文字`);
    return text.slice(0, 500);
  } catch (err) {
    logger.warn(`本文要約 API エラー → summary で代替: ${err instanceof Error ? err.message : String(err)}`);
    return body.replace(/\s+/g, ' ').trim().slice(0, 500);
  }
}

/**
 * 記事タイトルと本文から40文字以内の概要を生成する（Claude Haiku）
 */
export async function generateSummary40(
  anthropic: Anthropic,
  title: string,
  body: string
): Promise<string> {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `以下の記事タイトルと本文を40文字以内の日本語で要約してください。
ルール:
- 必ず日本語のみで出力する
- 記事が英語（または他の外国語）の場合は、日本語に翻訳した上で内容を要約する
- 40文字以内で必ず完結させる
- 説明・謝罪・前置きなしで内容だけ書く
- 本文が少なくてもタイトルから推測して必ず要約する

タイトル: ${title}
本文（先頭500文字）: ${body.slice(0, 500)}`,
        },
      ],
    });
    const raw = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    // "# 要約" などのMarkdownヘッダーを除去して本文だけ取り出す
    const text = raw
      .replace(/^#+\s.*\n?/gm, '')   // ## 見出し行を削除
      .replace(/^\s*\n/gm, '')        // 空行を削除
      .trim();
    logger.info(`概要生成完了: ${text.slice(0, 40)}`);
    return text.slice(0, 40);
  } catch (err) {
    logger.warn(`概要生成 API エラー → 本文先頭で代替: ${err instanceof Error ? err.message : String(err)}`);
    return body.replace(/\s+/g, ' ').slice(0, 40);
  }
}
