import Anthropic from '@anthropic-ai/sdk';
import { ArticleContent } from '../scraper/article';
import { XCategory, CATEGORY_META, SlotName } from './x-category';
import { filterPii, maskPiiByPattern } from './pii-filter';
import { tagPrefix } from './post-tag';
import { logger } from './logger';

/** TikTok キャプション上限 (表示上は2200だが検索・推薦では150が効果的) */
const TIKTOK_CAPTION_MAX = 150;

/** カテゴリ別 TikTok ハッシュタグプリセット */
const TIKTOK_BASE_TAGS = ['#AI', '#人工知能', '#テクノロジー'];

const TIKTOK_CATEGORY_TAGS: Partial<Record<XCategory, string[]>> = {
  trend:          ['#AIトレンド', '#テック'],
  model_release:  ['#新モデル', '#LLM'],
  paper:          ['#AI研究', '#論文'],
  regulation:     ['#AI規制'],
  ethics:         ['#AI倫理'],
  tool_product:   ['#AIツール'],
  dev_tech:       ['#AI開発'],
  agent:          ['#AIエージェント'],
  opensource:     ['#OSS'],
  business:       ['#AI活用'],
  startup:        ['#スタートアップ'],
  image_video_ai: ['#画像生成AI'],
  rag_search:     ['#RAG'],
  audio_multimodal: ['#音声AI'],
};

function buildTikTokHashtags(category?: XCategory): string {
  const specific = category ? (TIKTOK_CATEGORY_TAGS[category] ?? []) : [];
  return [...TIKTOK_BASE_TAGS, ...specific].slice(0, 5).join(' ');
}

export interface ComposeTikTokOpts {
  category?: XCategory;
  slot?: SlotName;
}

/**
 * TikTok 用のキャプションテキストを生成する。
 *
 * 構成: [カテゴリ絵文字] [一言フック] [ハッシュタグ]
 * 合計 150 字以内。URLは含めない（TikTok はリンクが機能しないため）。
 */
export async function composeTikTokCaption(
  anthropic: Anthropic,
  article: ArticleContent,
  opts?: ComposeTikTokOpts
): Promise<string> {
  const categoryMeta = opts?.category ? CATEGORY_META[opts.category] : null;
  const tagPart = tagPrefix(opts?.category);  // 例: "#業界動向\n"
  const emojiPart = categoryMeta ? `${categoryMeta.emoji} ` : '';
  const prefix = `${tagPart}${emojiPart}`;
  const hashtags = buildTikTokHashtags(opts?.category);
  const maxBodyLen = TIKTOK_CAPTION_MAX - prefix.length - hashtags.length - 2;

  let body = '';
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `以下のAI記事をTikTokのキャプション用に${maxBodyLen}文字以内で1〜2文で説明してください。
ルール:
- 日本語のみ
- ハッシュタグ・URL・タイトルは不要（後で自動付与します）
- 前置き・説明なしで本文のみ出力
- 読者が「もっと知りたい」と思えるフック文にする
- 個人情報（氏名・メール・電話）を絶対に含めないこと

タイトル: ${article.title}
概要: ${article.summary.slice(0, 200)}`,
      }],
    });

    body = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
  } catch (err) {
    logger.warn(`TikTok キャプション生成失敗 → タイトルで代替: ${err instanceof Error ? err.message : String(err)}`);
    body = article.title;
  }

  if (!body || ['申し訳', '本文をご提供'].some(p => body.includes(p))) {
    body = article.title;
  }

  body = body.slice(0, maxBodyLen);
  body = maskPiiByPattern(body);
  body = await filterPii(anthropic, body);
  body = body.slice(0, maxBodyLen);

  const caption = `${prefix}${body}\n\n${hashtags}`;
  logger.info(`TikTok キャプション生成: ${caption.length}文字 / カテゴリ: ${opts?.category ?? 'なし'}`);
  return caption;
}
