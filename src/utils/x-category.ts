/**
 * X 投稿用 20テーマ定義・分類・スロット割り当て
 *
 * スロット構成（平日のみ・各スロット4件通常+1件ネタ系=5件/スロット・計25件/日）:
 *   07:00 slot07  通勤: トレンド / 海外の流行 / ビジネス / スタートアップ
 *   11:00 slot11  午前: 新モデル / ロードマップ / AIツール / 画像・動画AI
 *   13:00 slot12  昼:   調査手法 / データ統計 / 論文 / RAG・検索
 *   16:00 slot14  午後: カンファレンス / 展示デモ / 規制 / AI倫理
 *   18:00 slot17  夕方: 実装・開発 / 音声マルチモーダル / AIエージェント / OSS
 */

export type SlotName = 'slot07' | 'slot11' | 'slot12' | 'slot14' | 'slot17';

export const X_CATEGORIES = [
  'trend',
  'global',
  'model_release',
  'model_roadmap',
  'research_method',
  'data_stats',
  'paper',
  'conference',
  'demo_exhibit',
  'dev_tech',
  'business',
  'startup',
  'regulation',
  'ethics',
  'tool_product',
  'image_video_ai',
  'audio_multimodal',
  'agent',
  'rag_search',
  'opensource',
  // 気休めネタ（スロットには割り当てず、post-relief.ts が直接使用）
  'relief',
] as const;

export type XCategory = (typeof X_CATEGORIES)[number];

export interface CategoryMeta {
  emoji: string;
  /** 【XXX】のラベル */
  label: string;
  /** ツイート生成プロンプトに注入する切り口 */
  angle: string;
  /** カテゴリ固有ハッシュタグ */
  hashtags: string;
}

export const CATEGORY_META: Record<XCategory, CategoryMeta> = {
  trend: {
    emoji: '📈',
    label: 'トレンド',
    angle: '今この瞬間に注目すべきAIの動きと、なぜ今重要なのかを',
    hashtags: '#AI #生成AI #AIトレンド',
  },
  global: {
    emoji: '🌐',
    label: '海外の流行',
    angle: '海外でバズっている理由・背景と日本への影響・示唆を',
    hashtags: '#AINews #海外AI #生成AI',
  },
  model_release: {
    emoji: '🤖',
    label: '新モデル',
    angle: '前世代から何が変わったか・何ができるようになったかを具体的に',
    hashtags: '#AIモデル #LLM #生成AI',
  },
  model_roadmap: {
    emoji: '🗺️',
    label: 'AIロードマップ',
    angle: '今後の開発方向・競合との比較・業界への影響を',
    hashtags: '#AI #LLM #AIロードマップ',
  },
  research_method: {
    emoji: '🔬',
    label: '調査手法',
    angle: 'この研究・調査アプローチのユニークな点と実用的な示唆を',
    hashtags: '#AI研究 #機械学習 #研究手法',
  },
  data_stats: {
    emoji: '📊',
    label: 'データ・統計',
    angle: '数字で見えるAIの実態と業界トレンドの背景を',
    hashtags: '#AIデータ #統計 #AI調査',
  },
  paper: {
    emoji: '📄',
    label: '論文ピックアップ',
    angle: '重要な発見と、エンジニア・研究者が実際に使えるポイントを',
    hashtags: '#AI論文 #arXiv #研究',
  },
  conference: {
    emoji: '🎤',
    label: 'カンファレンス',
    angle: 'この発表・講演で注目すべき内容と業界への意味・影響を',
    hashtags: '#AIイベント #カンファレンス',
  },
  demo_exhibit: {
    emoji: '🖥️',
    label: '展示・デモ',
    angle: '実際に体験できること・見どころと活用シーンを',
    hashtags: '#AIデモ #展示 #体験',
  },
  dev_tech: {
    emoji: '💻',
    label: '実装・開発',
    angle: '実装のコツ・技術的な面白さとエンジニアが知るべき点を',
    hashtags: '#AI開発 #エンジニア #プログラミング',
  },
  business: {
    emoji: '🤝',
    label: 'ビジネス活用',
    angle: '導入効果・ROI・成功のカギと自社での活用ヒントを',
    hashtags: '#AI活用 #DX #業務効率化',
  },
  startup: {
    emoji: '🚀',
    label: 'スタートアップ',
    angle: '何を解決しているか・資金調達の背景と市場インパクトを',
    hashtags: '#AIスタートアップ #資金調達 #AI',
  },
  regulation: {
    emoji: '🔒',
    label: '規制・法律',
    angle: '企業が今すぐ知っておくべき規制動向と対応のポイントを',
    hashtags: '#AI規制 #コンプライアンス #法律',
  },
  ethics: {
    emoji: '⚖️',
    label: 'AI倫理',
    angle: 'リスクと対策・倫理的な課題と企業・個人の責任を',
    hashtags: '#AI倫理 #AIリスク #責任あるAI',
  },
  tool_product: {
    emoji: '🛠️',
    label: 'AIツール',
    angle: '何が便利か・競合との差別化と使い始めるための情報を',
    hashtags: '#AIツール #生産性向上 #業務効率',
  },
  image_video_ai: {
    emoji: '🖼️',
    label: '画像・動画AI',
    angle: '品質・速度・用途の変化と実際の活用シーンを',
    hashtags: '#画像生成AI #動画AI #クリエイティブAI',
  },
  audio_multimodal: {
    emoji: '🎙️',
    label: '音声・マルチモーダル',
    angle: '使いどころ・精度の現状と近未来の可能性を',
    hashtags: '#音声AI #マルチモーダル #AIボイス',
  },
  agent: {
    emoji: '🤖',
    label: 'AIエージェント',
    angle: '何を自律でやるか・現状の限界と実用化のポイントを',
    hashtags: '#AIエージェント #自律AI #AutoGPT',
  },
  rag_search: {
    emoji: '🔍',
    label: 'RAG・検索',
    angle: '精度改善のポイントと実装で気をつけるべき点を',
    hashtags: '#RAG #AISearch #LLM',
  },
  opensource: {
    emoji: '🌱',
    label: 'オープンソース',
    angle: 'コミュニティの動き・商用との差と実務での使い方を',
    hashtags: '#OSS #オープンソースAI #HuggingFace',
  },
  // 気休めネタ（AI ニュースの合間に挟む癒し・科学・動物・スポーツ）
  relief: {
    emoji: '💚',
    label: '気休め',
    angle: '「いいね」「フーン」「なるほど」「かわいい」と感じるような温かいネタを',
    hashtags: '#癒し #ほっこり #豆知識',
  },
};

// ----------------------------------------------------------------
// スロット設定
// ----------------------------------------------------------------

/** スロット → 担当4テーマ */
export const SLOT_THEMES: Record<SlotName, [XCategory, XCategory, XCategory, XCategory]> = {
  slot07: ['trend',           'global',          'business',        'startup'],
  slot11: ['model_release',   'model_roadmap',   'tool_product',    'image_video_ai'],
  slot12: ['research_method', 'data_stats',      'paper',           'rag_search'],
  slot14: ['conference',      'demo_exhibit',    'regulation',      'ethics'],
  slot17: ['dev_tech',        'audio_multimodal','agent',           'opensource'],
};

/**
 * スロット拡張テーマ（batchSize > 4 時の追加カテゴリ）
 *
 * level 3-4 では batchSizePerSlot=4-5 となる。
 * 5件目以降はこのリストから順番に選択されることで、
 * 週末(slot07/11/12 のみ)でも 14+/20 カテゴリをカバーできる。
 *
 * slot07 → slot14/17 のカテゴリを補完
 * slot11 → slot14 のカテゴリを補完
 * slot12 → slot17 のカテゴリを補完
 * slot14 → slot12/17 のカテゴリを補完
 * slot17 → slot14/12 のカテゴリを補完
 */
export const SLOT_EXTENDED_THEMES: Record<SlotName, XCategory[]> = {
  slot07: ['conference', 'dev_tech', 'regulation', 'agent'],
  slot11: ['ethics',     'regulation', 'conference', 'dev_tech'],
  slot12: ['dev_tech',   'agent',      'regulation', 'ethics'],
  slot14: ['model_release', 'dev_tech', 'paper', 'startup'],
  slot17: ['conference', 'ethics',     'data_stats', 'model_release'],
};

/** スロット共通ハッシュタグ（カテゴリの hashtags に差し替えられる） */
export const SLOT_HASHTAGS: Record<SlotName, string> = {
  slot07: '#AI #生成AI #AIビジネス',
  slot11: '#AIモデル #ChatGPT #生成AI',
  slot12: '#AI研究 #論文 #LLM',
  slot14: '#AIイベント #AI規制 #AI',
  slot17: '#AI開発 #エンジニア #OSS',
};

/** スロット → cron 式（Asia/Tokyo） */
export const SLOT_CRON: Record<SlotName, string> = {
  slot07: '0  7 * * 1-5', // 07:00
  slot11: '0 11 * * 1-5', // 11:00
  slot12: '0 13 * * 1-5', // 13:00
  slot14: '0 16 * * 1-5', // 16:00
  slot17: '0 18 * * 1-5', // 18:00
};

/** スロット → 目標 JST 時刻（時・分）— post-all-slots.ts で時刻待機に使用 */
export const SLOT_TARGET_HOUR: Record<SlotName, { hour: number; minute: number }> = {
  slot07: { hour:  7, minute: 0 },
  slot11: { hour: 11, minute: 0 },
  slot12: { hour: 13, minute: 0 },
  slot14: { hour: 16, minute: 0 },
  slot17: { hour: 18, minute: 0 },
};

// ----------------------------------------------------------------
// キーワードベース分類
// ----------------------------------------------------------------

const KEYWORD_MAP: Record<XCategory, string[]> = {
  trend: [
    'trend', 'トレンド', '動向', '注目', '最新', 'latest', 'hot', 'buzz',
    '業界動向', '市場', 'market', '国内', '普及', '現状', 'growing', 'surge',
  ],
  global: [
    'silicon valley', 'openai', 'google', 'microsoft', 'meta', 'amazon',
    'anthropic', ' us ', 'usa', 'europe', 'china', '海外', '米国', '欧州', '中国',
    'worldwide', 'global', 'international', 'american', 'uk ', 'european',
  ],
  model_release: [
    'release', 'launch', 'リリース', '公開', '発表', 'new model', 'announced',
    'gpt-', 'claude-', 'gemini', 'llama', 'mistral', 'qwen', 'phi-', 'grok',
    '新モデル', 'バージョン', 'version', 'updated', 'アップデート', 'introduces',
  ],
  model_roadmap: [
    'roadmap', 'ロードマップ', 'upcoming', '予定', '計画', 'future model',
    'next generation', '次世代', '将来', 'plan', 'vision', 'context window',
    'benchmark', 'comparison', '比較', '性能比較', 'beats', 'surpasses',
  ],
  research_method: [
    'research', '研究', 'study', 'approach', '手法', 'methodology', '実験',
    'experiment', 'evaluation', '評価', 'ablation', 'propose', '提案',
    '調査', 'survey', 'analysis', 'novel method', 'we show', 'we propose',
  ],
  data_stats: [
    'data', 'データ', 'statistics', '統計', 'report', 'レポート',
    '%', 'percent', '割合', '件数', 'growth', '成長率', 'adoption rate',
    'dataset', 'データセット', 'findings', '調査結果', 'according to',
  ],
  paper: [
    'paper', '論文', 'arxiv', 'research paper', 'journal', 'academic',
    'published', 'conference paper', 'preprint', 'study shows', 'our paper',
    'researchers', '研究者', 'findings', '発見', 'neurips', 'icml', 'iclr',
  ],
  conference: [
    'conference', 'summit', 'symposium', 'forum', 'カンファレンス',
    'neurips', 'icml', 'iclr', 'acl', 'cvpr', 'aaai', 'wwdc', 'google io',
    'session', 'keynote', '基調講演', '登壇', 'talk', 'presenting at',
  ],
  demo_exhibit: [
    'demo', 'demonstration', 'exhibit', '展示', 'showcase', 'デモ',
    'hands-on', 'ハンズオン', 'try', '体験', 'live', 'preview',
    'reveal', 'unveiled', 'introduces', 'shows off', 'first look',
  ],
  dev_tech: [
    'implementation', '実装', 'code', 'コード', 'api', 'sdk', 'library',
    'github', 'developer', '開発者', 'programming', 'architecture',
    'アーキテクチャ', 'technical', '技術', 'engineering', 'tutorial',
  ],
  business: [
    'business', 'ビジネス', 'enterprise', 'company', '企業', 'roi',
    'productivity', '生産性', 'efficiency', '効率', 'use case', '活用事例',
    '導入', 'adoption', 'deployment', 'customer', '顧客', 'revenue',
  ],
  startup: [
    'startup', 'スタートアップ', 'funding', '資金調達', 'series a', 'series b',
    'series c', 'seed', 'venture', 'vc', 'investment', '投資', 'valuation',
    'raises', 'million', 'billion', '億', 'unicorn', 'founded', 'stealth',
  ],
  regulation: [
    'regulation', '規制', 'law', '法律', 'policy', 'ポリシー', 'compliance',
    'コンプライアンス', 'eu ai act', 'nist', 'gdpr', '個人情報', 'privacy',
    'government', '政府', '省庁', '総務省', '経産省', 'legislation', 'ban',
  ],
  ethics: [
    'ethics', '倫理', 'bias', 'バイアス', 'fairness', '公平性', 'safety',
    '安全性', 'harmful', 'risk', 'リスク', 'responsible', '責任',
    'alignment', 'misuse', '悪用', 'transparency', '透明性', 'deepfake',
    'governance', 'ガバナンス', 'superalignment', 'x-risk', 'existential',
    'ai safety', 'responsible ai', '安全性評価', 'リスク評価', 'リスク管理',
    'societal impact', '社会的影響', 'misinformation', '偽情報', 'hallucination',
    'ハルシネーション', 'explainability', '説明可能', 'accountability', '説明責任',
    'human rights', '人権', 'discrimination', '差別', 'privacy violation',
  ],
  tool_product: [
    'tool', 'ツール', 'product', '製品', 'service', 'サービス', 'app', 'アプリ',
    'platform', 'プラットフォーム', 'feature', '機能', 'workflow',
    'productivity', 'automation', '自動化', 'assistant', 'copilot',
  ],
  image_video_ai: [
    'image generation', '画像生成', 'text-to-image', 'midjourney', 'dall-e',
    'stable diffusion', 'video generation', '動画生成', 'sora', 'runway',
    'image', 'video', 'visual ai', '映像', 'animation', 'flux', 'imagen',
    'leonardo', 'firefly', 'adobe firefly', 'kling', 'heygen', 'pika',
    'ideogram', 'text-to-video', 'image synthesis', 'diffusion model',
    '画像AI', '動画AI', 'generative image', 'generative video',
    'stability ai', 'stable video', 'comfyui', 'controlnet',
    'lora', 'dreambooth', 'inpainting', 'outpainting', 'upscaling',
    'ai art', 'ai画像', 'ai動画', 'cinematography', 'visual generation',
  ],
  audio_multimodal: [
    'audio', '音声', 'speech', 'voice', 'text-to-speech', 'tts',
    'speech-to-text', 'stt', 'multimodal', 'マルチモーダル', 'whisper',
    'music generation', '音楽生成', 'sound', 'podcast', 'eleven labs',
  ],
  agent: [
    'agent', 'エージェント', 'autonomous', '自律', 'agentic', 'multi-agent',
    'tool use', 'function calling', 'planning', 'chain of thought',
    'workflow automation', 'orchestration', 'crew ai', 'autogen', 'langgraph',
  ],
  rag_search: [
    'rag', 'retrieval', '検索', 'vector', 'embedding', 'semantic search',
    'knowledge base', '知識ベース', 'pinecone', 'chroma', 'weaviate',
    'langchain', 'llamaindex', 'grounding', 'context length', 'rerank',
  ],
  opensource: [
    'open source', 'オープンソース', 'open model', 'open weights',
    'mit license', 'apache', 'community', 'コミュニティ', 'hugging face',
    'contribution', 'fork', 'repository', 'ollama', 'open llm', 'gguf',
  ],
  // relief: キーワードなし → classifyItem() では決して選択されない（score 0 は除外）
  relief: [],
};

/**
 * キーワードスコアリングにより記事を20テーマのいずれかに分類する。
 *
 * - スコア最大のテーマを返す
 * - マッチなし（全スコア 0）の場合は null を返す
 */
export function classifyItem(title: string, summary: string): XCategory | null {
  const text = `${title} ${summary}`.toLowerCase();
  let best: XCategory | null = null;
  let bestScore = 0;

  for (const cat of X_CATEGORIES) {
    let score = 0;
    for (const kw of KEYWORD_MAP[cat]) {
      if (text.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }

  return best;
}
