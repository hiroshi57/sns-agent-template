import Anthropic from '@anthropic-ai/sdk';
import { NoteWeeklyItem } from './note-weekly-log';
import { CATEGORY_META, XCategory } from './x-category';
import { logger } from './logger';

/**
 * XCategory → note ハッシュタグのマッピング
 * note はハッシュタグで記事をタグ付けできる（本文末尾に追記）
 */
const CATEGORY_NOTE_TAGS: Record<XCategory, string[]> = {
  trend:           ['#AIトレンド', '#AI最新情報'],
  global:          ['#海外AI', '#テクノロジーニュース'],
  model_release:   ['#新モデル', '#AI'],
  model_roadmap:   ['#AIロードマップ', '#AI戦略'],
  research_method: ['#AI研究', '#機械学習'],
  data_stats:      ['#データ分析', '#AI統計'],
  paper:           ['#AI論文', '#研究'],
  conference:      ['#AIカンファレンス', '#テックイベント'],
  demo_exhibit:    ['#AIデモ', '#テクノロジー'],
  dev_tech:        ['#AI開発', '#エンジニア'],
  business:        ['#AIビジネス', '#DX'],
  startup:         ['#AIスタートアップ', '#ビジネス'],
  regulation:      ['#AI規制', '#テクノロジー政策'],
  ethics:          ['#AI倫理', '#責任あるAI'],
  tool_product:    ['#AIツール', '#プロダクト'],
  image_video_ai:  ['#画像生成AI', '#動画AI'],
  audio_multimodal: ['#音声AI', '#マルチモーダル'],
  agent:           ['#AIエージェント', '#自律AI'],
  rag_search:      ['#RAG', '#AI検索'],
  opensource:      ['#オープンソース', '#LLM'],
  relief:          ['#AI', '#テクノロジー'],
};

/**
 * アイテムのカテゴリから note 用タグ一覧を生成する（重複除去・最大8タグ）
 */
function buildNoteTags(items: NoteWeeklyItem[]): string {
  const tagSet = new Set<string>(['#AIニュース', '#人工知能']);

  for (const item of items) {
    const tags = CATEGORY_NOTE_TAGS[item.category] ?? [];
    tags.forEach((t) => tagSet.add(t));
    if (tagSet.size >= 8) break;
  }

  return [...tagSet].join(' ');
}

export interface NoteArticle {
  title: string;
  body: string;
}

/** note 記事フッター（自社サービス誘導 + アフィリエイト） */
function buildFooter(): string {
  const serviceName = process.env['OWN_SERVICE_NAME'] || '';
  const serviceUrl  = process.env['OWN_SERVICE_URL']  || '';
  const affiliateText = process.env['NOTE_AFFILIATE_TEXT'] || '';

  const lines: string[] = ['---', ''];

  if (serviceName && serviceUrl) {
    lines.push(`▼ ${serviceName}`);
    lines.push(serviceUrl);
    lines.push('');
  }

  if (affiliateText) {
    lines.push(affiliateText);
    lines.push('');
  }

  lines.push('※ 本記事は毎日自動配信されるAIニュースまとめです。');
  lines.push('フォローすると最新情報を見逃しません。');

  return lines.join('\n');
}

/**
 * 日次 AI ニュースまとめ記事を生成する。
 *
 * 構成:
 *   タイトル: 「【日次まとめ】本日のAI重要ニュース（MM月DD日）」
 *   リード文（2〜3文）
 *   ─ トピック見出し × N個（各300字程度の解説）
 *   自社サービス誘導フッター
 */
export async function composeNoteArticle(
  anthropic: Anthropic,
  items: NoteWeeklyItem[]
): Promise<NoteArticle> {
  if (items.length === 0) {
    throw new Error('note 記事生成: 対象アイテムが0件です');
  }

  // 対象日付を計算
  const today = new Date();
  const dateLabel = `${today.getMonth() + 1}月${today.getDate()}日`;

  const title = `【日次まとめ】本日のAI重要ニュース（${dateLabel}）`;

  // 最大10件に絞る
  const selectedItems = items.slice(0, 10);

  // Claude にトピック別まとめ本文を生成させる
  const itemsText = selectedItems.map((item, i) => {
    const meta = CATEGORY_META[item.category];
    return `[${i + 1}] ${meta.emoji}【${meta.label}】\nタイトル: ${item.title}\n概要: ${item.summary.slice(0, 200)}\nURL: ${item.url}`;
  }).join('\n\n');

  let body = '';
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `以下の本日のAI/テクノロジーニュース ${selectedItems.length} 件をnoteの日次まとめ記事として執筆してください。

【形式】
- 冒頭に2〜3文のリード文（本日の全体的な傾向を述べる）
- 各トピックは「## [番号]. タイトル」の見出しで始める
- 各トピックは200〜300字の解説（なぜ重要か・何が変わるか・読者への示唆）
- 記事全体は読みやすい日本語で、ですます調
- 個人名・内部情報・個人情報は絶対に含めないこと
- ハッシュタグは不要
- URLは各トピックの末尾に「🔗 詳細: [URL]」形式で記載

【ニュース一覧】
${itemsText}`,
      }],
    });

    body = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    logger.info(`note 記事本文生成: ${body.length}文字`);
  } catch (err) {
    logger.warn(`note 記事生成失敗 → シンプル形式で代替: ${err instanceof Error ? err.message : String(err)}`);
    body = buildSimpleBody(selectedItems, dateLabel);
  }

  if (!body || body.length < 100) {
    body = buildSimpleBody(selectedItems, dateLabel);
  }

  const footer = buildFooter();
  // カテゴリ別タグ（#AIニュース #人工知能 + アイテムのカテゴリから最大8タグ）
  const noteTags = buildNoteTags(selectedItems);
  const fullBody = `${body}\n\n${footer}\n\n${noteTags}`;

  return { title, body: fullBody };
}

/** 後方互換エイリアス */
export const composeNoteWeeklyArticle = composeNoteArticle;

/** Claude 失敗時のシンプルな本文生成（フォールバック） */
function buildSimpleBody(items: NoteWeeklyItem[], periodLabel: string): string {
  const lines: string[] = [
    `本日（${periodLabel}）のAI/テクノロジー重要ニュースをまとめました。`,
    '',
  ];

  for (const item of items) {
    const meta = CATEGORY_META[item.category];
    lines.push(`## ${meta.emoji} ${item.title}`);
    lines.push('');
    lines.push(item.summary.slice(0, 200));
    lines.push('');
    lines.push(`🔗 詳細: ${item.url}`);
    lines.push('');
  }

  return lines.join('\n');
}
