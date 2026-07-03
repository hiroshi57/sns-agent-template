import Anthropic from '@anthropic-ai/sdk';
import { ArticleContent } from '../scraper/article';
import { XCategory, CATEGORY_META, SlotName } from './x-category';
import { filterPii, maskPiiByPattern } from './pii-filter';
import { tagPrefix } from './post-tag';
import { logger } from './logger';

/** Instagram は 2200 字上限、Threads は 500 字 */
const INSTAGRAM_MAX = 2200;
const THREADS_MAX = 500;

/** カテゴリ別ハッシュタグプリセット（AI 系共通 + カテゴリ固有） */
const BASE_HASHTAGS = [
  '#AI', '#人工知能', '#テクノロジー', '#AIニュース',
  '#DX', '#デジタルトランスフォーメーション', '#機械学習',
  '#ディープラーニング', '#ChatGPT', '#生成AI',
];

const CATEGORY_HASHTAGS: Partial<Record<XCategory, string[]>> = {
  trend:          ['#AIトレンド', '#テックトレンド'],
  model_release:  ['#新モデル', '#LLM', '#GPT'],
  paper:          ['#AI論文', '#研究', '#arXiv'],
  regulation:     ['#AI規制', '#ガバナンス', '#法規制'],
  ethics:         ['#AI倫理', '#責任あるAI'],
  tool_product:   ['#AIツール', '#プロダクト', '#SaaS'],
  dev_tech:       ['#AIエンジニア', '#開発', '#プログラミング'],
  agent:          ['#AIエージェント', '#オートメーション'],
  opensource:     ['#オープンソース', '#OSS', '#GitHub'],
  business:       ['#ビジネス', '#経営', '#AI活用'],
  startup:        ['#スタートアップ', '#資金調達'],
  image_video_ai: ['#画像生成', '#動画AI', '#Sora'],
  rag_search:     ['#RAG', '#ベクトル検索'],
  audio_multimodal: ['#音声AI', '#マルチモーダル'],
};

function buildHashtags(category?: XCategory, maxCount = 20): string {
  const specific = category ? (CATEGORY_HASHTAGS[category] ?? []) : [];
  const tags = [...BASE_HASHTAGS, ...specific].slice(0, maxCount);
  return tags.join(' ');
}

export interface ComposeInstagramOpts {
  category?: XCategory;
  slot?: SlotName;
  /** Instagram 本文の最大文字数（デフォルト: 2200） */
  maxLength?: number;
}

/**
 * Instagram / Threads 用の投稿テキストを生成する。
 *
 * 構成:
 *   [カテゴリ絵文字 + ラベル]
 *   [記事タイトル]
 *   [本文要約（詳細めに、2〜4段落）]
 *   [元記事 URL]
 *   [ハッシュタグ]
 *
 * Twitter と異なり文字数に余裕があるため、より詳しい解説を含む。
 */
export async function composeInstagramPost(
  anthropic: Anthropic,
  article: ArticleContent,
  opts?: ComposeInstagramOpts
): Promise<string> {
  const maxLen = opts?.maxLength ?? INSTAGRAM_MAX;
  const categoryMeta = opts?.category ? CATEGORY_META[opts.category] : null;
  const tagPart = tagPrefix(opts?.category);
  const labelPart = categoryMeta
    ? `${categoryMeta.emoji}【${categoryMeta.label}】\n`
    : '';
  const prefix = `${tagPart}${labelPart}`;

  const hashtags = buildHashtags(opts?.category);
  const hashtagPart = `\n\n${hashtags}`;
  const urlPart = `\n\n${article.url}`;

  const maxBodyLen = maxLen - prefix.length - article.title.length - 1
    - urlPart.length - hashtagPart.length - 10; // バッファ

  const angleNote = categoryMeta
    ? `\n- 特に「${categoryMeta.angle}」という視点で書くこと` : '';

  let body = '';
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `以下のAI/テクノロジー記事をInstagramの投稿文として${maxBodyLen}文字以内で説明してください。
ルール:
- 日本語のみ
- ハッシュタグ・URLは不要（後で自動付与します）
- タイトルも不要（後で別途付与します）
- 前置き・説明なしで本文のみ出力
- 個人情報（氏名・メール・電話番号・住所）を絶対に含めないこと
- 2〜3段落構成で、読者が「続きが読みたい」と思える内容にする
- 1段落目: 何が起きたか・何が発表されたか（フック）
- 2段落目: 具体的な内容・数字・技術的な詳細
- 3段落目: ビジネスへの示唆・今後の影響（締め）${angleNote}

タイトル: ${article.title}
概要: ${article.summary.slice(0, 400)}`,
      }],
    });

    body = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
  } catch (err) {
    logger.warn(`Instagram 本文生成失敗 → 要約で代替: ${err instanceof Error ? err.message : String(err)}`);
    body = article.summary.slice(0, maxBodyLen);
  }

  if (!body || ['申し訳', '本文をご提供', '情報をご提供'].some(p => body.includes(p))) {
    body = article.summary.slice(0, maxBodyLen);
  }

  body = body.slice(0, maxBodyLen);
  body = maskPiiByPattern(body);
  body = await filterPii(anthropic, body);
  body = body.slice(0, maxBodyLen);

  const post = `${prefix}${article.title}\n\n${body}${urlPart}${hashtagPart}`;
  logger.info(`Instagram 投稿文生成: ${post.length}文字 / カテゴリ: ${opts?.category ?? 'なし'}`);
  return post;
}

/**
 * Threads 用の短縮バージョン（500 字以内）を生成する。
 * Instagram 版より短く、Twitter に近い長さ。
 */
export async function composeThreadsPost(
  anthropic: Anthropic,
  article: ArticleContent,
  opts?: ComposeInstagramOpts
): Promise<string> {
  return composeInstagramPost(anthropic, article, {
    ...opts,
    maxLength: THREADS_MAX,
  });
}
