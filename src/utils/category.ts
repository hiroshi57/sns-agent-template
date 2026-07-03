import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger';

// ----------------------------------------------------------------
// カテゴリ定義
// ----------------------------------------------------------------
export const FORTE_CATEGORIES = [
  '業界動向',
  '活用事例',
  'ガイドライン',
  'Tips',
  'アップデート',
  'エンジニアリング',
] as const;

export type ForteCategory = (typeof FORTE_CATEGORIES)[number];

// ----------------------------------------------------------------
// キーワードフォールバック辞書
// ----------------------------------------------------------------
const KEYWORD_MAP: Record<ForteCategory, string[]> = {
  業界動向: [
    '市場', 'トレンド', '調査', 'レポート', '動向', '統計', 'シェア',
    '投資', '予測', '成長', '業界', '国内', '海外', '普及', '現状',
  ],
  活用事例: [
    '事例', '導入', '活用', '成功', '実績', '企業', '採用', '運用',
    'ユースケース', 'インタビュー', '取り組み', '実践', '効果',
  ],
  ガイドライン: [
    'ガイドライン', '規制', '法律', 'ポリシー', '基準', '規約',
    'コンプライアンス', '倫理', 'リスク管理', '安全', '責任', '透明性',
    'EU AI Act', 'NIST', '内閣府', '経産省', '総務省',
  ],
  Tips: [
    'Tips', 'ヒント', '方法', 'コツ', '使い方', '活用法',
    'テクニック', '初心者', '入門', 'おすすめ', 'プロンプト',
    '効率', '生産性', '改善', 'ベストプラクティス',
  ],
  アップデート: [
    'リリース', 'バージョン', 'アップデート', '新機能', '発表',
    '公開', 'β版', 'ベータ', 'GA', '正式', 'Claude', 'GPT',
    'Gemini', 'Llama', 'Mistral', 'モデル公開',
  ],
  エンジニアリング: [
    '実装', 'コード', 'アーキテクチャ', 'API', '技術', '開発',
    '論文', 'Research', 'RAG', 'ファインチューニング', 'Fine-tuning',
    'パラメータ', 'トークン', 'エンベディング', 'Vector', 'LLM',
    'マルチモーダル', 'エージェント', 'Agent',
  ],
};

// ----------------------------------------------------------------
// キーワードベースのフォールバック判定
// ----------------------------------------------------------------
function classifyByKeyword(title: string, summary: string): ForteCategory {
  const text = `${title} ${summary}`.toLowerCase();

  const scores: Record<ForteCategory, number> = {
    業界動向: 0,
    活用事例: 0,
    ガイドライン: 0,
    Tips: 0,
    アップデート: 0,
    エンジニアリング: 0,
  };

  for (const [cat, keywords] of Object.entries(KEYWORD_MAP) as [ForteCategory, string[]][]) {
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        scores[cat] += 1;
      }
    }
  }

  // スコア最大のカテゴリを返す（同点なら業界動向をデフォルト）
  const best = (Object.entries(scores) as [ForteCategory, number][]).reduce(
    (a, b) => (b[1] > a[1] ? b : a),
    ['業界動向' as ForteCategory, 0]
  );

  logger.info(`カテゴリ判定（キーワード）: "${best[0]}" (score=${best[1]})`);
  return best[0];
}

// ----------------------------------------------------------------
// Claude API によるカテゴリ判定
// ----------------------------------------------------------------
export async function selectCategory(
  anthropic: Anthropic,
  title: string,
  summary: string
): Promise<ForteCategory> {
  const categoriesStr = FORTE_CATEGORIES.join('、');

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [
        {
          role: 'user',
          content: `あなたはAI・データサイエンス情報メディアの編集者です。
以下の記事タイトルと概要を読み、最も適切なカテゴリを1つだけ選んでください。

カテゴリ一覧: ${categoriesStr}

タイトル: ${title}
概要: ${summary.slice(0, 200)}

回答はカテゴリ名のみを出力してください（説明不要）。`,
        },
      ],
    });

    const raw = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    const matched = FORTE_CATEGORIES.find((c) => raw.includes(c));

    if (matched) {
      logger.info(`カテゴリ判定（Claude）: "${matched}"`);
      return matched;
    }

    // Claude の回答がカテゴリ一覧に含まれなければフォールバック
    logger.warn(`Claude 回答 "${raw}" がカテゴリ一覧に未一致 → キーワード判定へ`);
    return classifyByKeyword(title, summary);
  } catch (err) {
    logger.warn(`Claude API エラー → キーワード判定へ: ${err instanceof Error ? err.message : String(err)}`);
    return classifyByKeyword(title, summary);
  }
}
