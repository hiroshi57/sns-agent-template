/**
 * 投稿タグユーティリティ
 *
 * 記事カテゴリ（XCategory）を10種の日本語ハッシュタグに変換する。
 * X / Instagram / TikTok / note の各コンポーザーで共通利用。
 *
 * タグは件名（記事タイトル）の直前に配置される:
 *   例) #業界動向
 *       OpenAIが新モデルを発表...
 */
import { XCategory } from './x-category';

/** 10種の投稿タグ */
export type PostTag =
  | '業界動向'
  | '活用事例'
  | 'ガイドライン'
  | 'Tips'
  | 'アップデート'
  | 'セキュリティ'
  | 'エンジニアリング'
  | '研究・論文'
  | 'イベント'
  | 'オープンソース';

/** XCategory → PostTag マッピング */
export const CATEGORY_TO_POST_TAG: Record<XCategory, PostTag> = {
  // 業界動向: マーケット・海外・スタートアップ・統計
  trend:            '業界動向',
  global:           '業界動向',
  startup:          '業界動向',
  data_stats:       '業界動向',

  // アップデート: モデルリリース・ロードマップ・マルチモーダル
  model_release:    'アップデート',
  model_roadmap:    'アップデート',
  image_video_ai:   'アップデート',
  audio_multimodal: 'アップデート',

  // 活用事例: ビジネス利用・ツール・プロダクト
  business:         '活用事例',
  tool_product:     '活用事例',

  // ガイドライン: 規制・法律・ポリシー
  regulation:       'ガイドライン',

  // セキュリティ: AI倫理・リスク・安全性
  ethics:           'セキュリティ',

  // エンジニアリング: 実装・エージェント・RAG
  dev_tech:         'エンジニアリング',
  agent:            'エンジニアリング',
  rag_search:       'エンジニアリング',

  // 研究・論文: 論文・調査手法
  paper:            '研究・論文',
  research_method:  '研究・論文',

  // イベント: カンファレンス・展示デモ
  conference:       'イベント',
  demo_exhibit:     'イベント',

  // オープンソース
  opensource:       'オープンソース',

  // 気休めネタは業界動向にフォールバック
  relief:           '業界動向',
};

/**
 * カテゴリに対応するタグを返す。
 * カテゴリ未指定の場合は null を返す。
 */
export function getPostTag(category?: XCategory): PostTag | null {
  if (!category) return null;
  return CATEGORY_TO_POST_TAG[category] ?? '業界動向';
}

/**
 * ハッシュタグ形式のプレフィックス文字列を返す。
 * 例: "#業界動向\n"
 *
 * @param category - XCategory（省略時は空文字列を返す）
 */
export function tagPrefix(category?: XCategory): string {
  const tag = getPostTag(category);
  return tag ? `#${tag}\n` : '';
}
