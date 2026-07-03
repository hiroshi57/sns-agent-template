/**
 * 個人情報（PII）フィルター
 *
 * X への投稿前に以下をテキストから除去・マスクする:
 *   - メールアドレス
 *   - 電話番号（日本・国際形式）
 *   - 日本の郵便番号
 *   - 住所パターン（都道府県〜番地）
 *   - 人名（姓名パターン）
 *   - 社内 URL（社内ドメインや VPN 系）
 *   - クレジットカード番号
 *   - マイナンバー
 *
 * 2段構成:
 *   1. 正規表現で確実に除去できるもの → 直接マスク
 *   2. Claude Haiku で文脈的に判断が必要なもの → AI判定
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger';

// ----------------------------------------------------------------
// 正規表現ベースのマスク
// ----------------------------------------------------------------

const PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  // メールアドレス
  {
    name: 'email',
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    replacement: '[メール削除]',
  },
  // 日本の電話番号（固定・携帯・フリーダイヤル）
  {
    name: 'phone_jp',
    pattern: /(?:0\d{1,4}[-‐‑‒–—―－\s]?\d{1,4}[-‐‑‒–—―－\s]?\d{3,4}|\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})/g,
    replacement: '[電話番号削除]',
  },
  // 日本の郵便番号
  {
    name: 'postal_jp',
    pattern: /〒?\d{3}[-‐－]\d{4}/g,
    replacement: '[郵便番号削除]',
  },
  // クレジットカード番号（4桁×4）
  {
    name: 'credit_card',
    pattern: /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}\b/g,
    replacement: '[カード番号削除]',
  },
  // マイナンバー（12桁）
  {
    name: 'my_number',
    pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
    replacement: '[番号削除]',
  },
  // 社内 URL（プライベート IP / localhost / 社内ドメイン）
  {
    name: 'internal_url',
    pattern: /https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)[^\s]*/g,
    replacement: '[社内URL削除]',
  },
];

/**
 * 正規表現で確実に除去できる PII をマスクする（Claude 不使用）
 */
export function maskPiiByPattern(text: string): string {
  let result = text;
  for (const { name, pattern, replacement } of PII_PATTERNS) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) {
      logger.info(`[PII除去] ${name} をマスクしました`);
    }
  }
  return result;
}

// ----------------------------------------------------------------
// Claude による文脈的 PII チェック
// ----------------------------------------------------------------

/**
 * Claude Haiku でテキストに個人情報が残っていないか最終確認し、
 * 残存していれば除去済みのテキストを返す。
 *
 * 正規表現では取れない「田中部長」「〇〇社の△△さん」などを除去対象にする。
 */
export async function sanitizePiiWithClaude(
  anthropic: Anthropic,
  text: string
): Promise<string> {
  // 短すぎるテキストはスキップ（タイトルのみなど）
  if (text.length < 10) return text;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: `以下のテキストから個人を特定できる情報をすべて除去してください。

【除去対象】
- 個人名（フルネーム・苗字のみでも人名とわかる場合）
- 所属・役職名と人名の組み合わせ（例: 「〇〇社の田中部長」→「担当者」）
- 個人のSNSアカウント名（@から始まるもの）
- 特定の住所・番地・部屋番号
- 社内システム名・社内プロジェクト名（一般に公開されていないもの）

【除去不要】
- AI企業名・製品名・サービス名（OpenAI, Google, Claude など）
- 公人・著名人の名前（研究者・CEO など公式に公表されている人物）
- 一般的な技術用語・業界用語

除去後のテキストのみ出力してください。除去するものがなければ原文をそのまま出力してください。

テキスト:
${text}`,
        },
      ],
    });

    const result = msg.content[0].type === 'text' ? msg.content[0].text.trim() : text;

    if (result !== text) {
      logger.info(`[PII除去] Claude が個人情報を検出・除去しました`);
    }
    return result;
  } catch (err) {
    // エラー時は正規表現済みのテキストをそのまま使用
    logger.warn(`[PII除去] Claude チェックエラー → パターン除去済みテキストで続行: ${err instanceof Error ? err.message : String(err)}`);
    return text;
  }
}

/**
 * 2段階 PII フィルター（パターン除去 → Claude 確認）
 * tweet-composer.ts から呼び出す。
 */
export async function filterPii(
  anthropic: Anthropic,
  text: string
): Promise<string> {
  const patternFiltered = maskPiiByPattern(text);
  return sanitizePiiWithClaude(anthropic, patternFiltered);
}
