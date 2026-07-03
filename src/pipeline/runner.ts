/**
 * パイプライン: スロット × テーマ別に最良記事を選出してバッチ化する
 *
 * 処理フロー:
 *   1. RSS アイテム + Chatwork アイテム(slot07) を受け取る
 *   2. 各アイテムをキーワード分類して XCategory を付与
 *   3. スロットの4テーマそれぞれで未投稿かつ最新の記事を1件選択
 *   4. PipelineItem 配列として返す（最大4件）
 */
import { RssItem } from '../rss/reader';
import { ArticleContent } from '../scraper/article';
import { PostedUrlCache } from '../utils/posted-url-cache';
import {
  SlotName,
  XCategory,
  CATEGORY_META,
  SLOT_EXTENDED_THEMES,
  classifyItem,
} from '../utils/x-category';
import { ContentStrategy, getEffectiveThemes, loadStrategy } from '../utils/strategy-store';
import { logger } from '../utils/logger';

// ── タイトル類似度チェック (#47) ─────────────────────────────────────

/**
 * タイトルを単語トークンセットに変換する（日本語・英語両対応）
 * - 英語: スペースで分割し小文字化
 * - 日本語: bigram（2文字 N-gram）に分解
 */
function tokenize(title: string): Set<string> {
  const lower = title.toLowerCase().trim();
  const tokens = new Set<string>();

  // 英語単語（2文字以上の単語のみ）
  for (const w of lower.split(/[\s\-_,.()\[\]]+/)) {
    if (w.length >= 2) tokens.add(w);
  }

  // 日本語 bigram（2文字以上の文字列）
  const jp = lower.replace(/[a-z0-9\s\-_,.()\[\]]/g, '');
  for (let i = 0; i < jp.length - 1; i++) {
    tokens.add(jp.slice(i, i + 2));
  }

  return tokens;
}

/**
 * Jaccard 類似度（0〜1）で2つのタイトルの類似度を計算する
 */
export function titleSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SIMILARITY_THRESHOLD = 0.65; // これ以上で「同じ記事」とみなす（バッチ内重複）

// ── クロススロット重複判定 ────────────────────────────────────────────

/**
 * 一般的な英語ストップワード（製品名・固有名詞を除くための除外リスト）
 * これらは「共通トークン」としてカウントしない。
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'new', 'has', 'are', 'was', 'his', 'her',
  'its', 'can', 'but', 'not', 'all', 'one', 'two', 'how', 'why', 'who',
  'what', 'when', 'this', 'that', 'from', 'into', 'over', 'also', 'more',
  'will', 'just', 'than', 'then', 'been', 'have', 'had', 'said', 'each',
  'most', 'your', 'they', 'them', 'their', 'out', 'use', 'used', 'using',
  'now', 'get', 'let', 'set', 'say', 'via', 'per', 'top', 'big', 'key',
]);

/**
 * タイトルから固有名詞・製品名候補を抽出する（3文字以上の英語トークン、ストップワード除外）。
 *
 * 例:
 *   "Sol/Terra/Lunaの3層展開" → {"sol", "terra", "luna"}
 *   "OpenAI releases GPT-5"   → {"openai", "releases", "gpt"}
 */
function extractRareTokens(title: string): Set<string> {
  const lower = title.toLowerCase();
  const tokens = new Set<string>();
  // "/" も含めた非英字区切りで分割し、純粋な英語トークンを抽出
  for (const w of lower.split(/[^a-z]+/)) {
    if (w.length >= 3 && !STOP_WORDS.has(w)) tokens.add(w);
  }
  return tokens;
}

/**
 * クロススロット重複判定。
 *
 * Jaccard では日本語テキストが多いと精度が落ちるため、
 * 製品名・固有名詞を表す稀少英語トークンの共有数で判定する。
 *
 * 2件以上のトークンが一致 → 同トピックの別記事（Sol/Terra/Luna 重複を捕捉）
 * 1件以下             → 異なるトピック（OpenAI 系など共通ワードの混入を防ぐ）
 *
 * @returns true = クロススロット重複（除外すべき）
 */
export function isCrossSlotDuplicate(newTitle: string, recentTitle: string): boolean {
  const newTokens  = extractRareTokens(newTitle);
  const prevTokens = extractRareTokens(recentTitle);
  let shared = 0;
  for (const t of newTokens) {
    if (prevTokens.has(t)) shared++;
  }
  return shared >= 2; // 2件以上の稀少トークン共有 → 同トピックとみなす
}

export interface PipelineItem {
  title: string;
  url: string;
  summary: string;
  /** og:image 等の画像 URL（なければ undefined） */
  imageUrl?: string;
  /** タイトルが英語かどうか（tweet-composer の英語フォーマット切り替え） */
  isEnglish: boolean;
  /** 分類されたテーマ */
  category: XCategory;
  /** このツイートに使うハッシュタグ */
  hashtags: string;
}

/** 内部処理用の統一アイテム型 */
interface UnifiedItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: Date;
  isEnglish: boolean;
  imageUrl?: string;
}

/** ArticleContent（Chatwork）を UnifiedItem に変換 */
function fromArticle(article: ArticleContent): UnifiedItem {
  return {
    title: article.title,
    url: article.url,
    summary: article.summary,
    publishedAt: new Date(), // Chatwork は取得時刻を使用
    isEnglish: false,         // Chatwork は基本的に日本語
    imageUrl: article.thumbnailUrl || undefined,
  };
}

/** RssItem を UnifiedItem に変換 */
function fromRssItem(item: RssItem): UnifiedItem {
  return {
    title: item.title,
    url: item.url,
    summary: item.summary,
    publishedAt: item.publishedAt,
    isEnglish: item.isEnglish,
    imageUrl: item.imageUrl,
  };
}

/**
 * スロットに対応する4テーマの最良記事を選出して返す（目標4件・最低保証あり）。
 *
 * フォールバック戦略（KPI 22件/日 達成のため）:
 *   1st pass: テーマキーワードが一致する記事を優先選択（1テーマ=1件）
 *   2nd pass: テーマ未割当 or 枠が余っている場合、未選択の全記事から新しい順に補充
 *   → これにより、RSS/Chatwork に記事がある限り必ず SLOT_TARGET 件を返す
 *
 * @param slot         実行スロット名
 * @param rssItems     fetchAllRssItems() の結果
 * @param cwArticles   Chatwork 記事一覧（slot07 用。他スロットでも fallback に使用）
 * @param cache        投稿済み URL キャッシュ
 * @param targetCount  目標件数（デフォルト 4。index-x.ts から BATCH_SIZE=5 で呼ぶ → 5スロット×5件=25件/日）
 */
export function buildSlotBatch(
  slot: SlotName,
  rssItems: RssItem[],
  cwArticles: ArticleContent[],
  cache: PostedUrlCache,
  targetCount = 4,
  strategy?: ContentStrategy,
  /**
   * クロススロット重複防止: 当日の前スロットで投稿済みの記事タイトル一覧。
   * このリストに含まれるタイトルと SIMILARITY_THRESHOLD 以上類似する記事は除外する。
   * 同じトピックを複数スロットで投稿するのを防ぐ（例: Sol/Terra/Luna 記事の重複）。
   */
  recentPostedTitles: string[] = [],
): PipelineItem[] {
  const effectiveStrategy = strategy ?? loadStrategy();
  const themes = getEffectiveThemes(slot, effectiveStrategy);

  // ── 全アイテムを統一型に変換（Chatwork + RSS） ──
  const allItems: UnifiedItem[] = [
    ...cwArticles.map(fromArticle),
    ...rssItems.map(fromRssItem),
  ];

  // ── テーマ別グループ化 + 全未投稿アイテムのリストを別途保持 ──
  const themeGroups = new Map<XCategory, UnifiedItem[]>();
  const allUnposted: UnifiedItem[] = []; // フォールバック用プール
  const seenUrls = new Set<string>();
  // タイトル類似度チェック用: クロススロット重複防止タイトルを先にロード (#47+)
  const seenTitles: string[] = [...recentPostedTitles];

  for (const item of allItems) {
    if (cache.has(item.url)) continue;
    if (seenUrls.has(item.url)) continue;

    // タイトル類似度チェック (#47):
    //   ① バッチ内重複: Jaccard ≥ 0.65（同一記事の書き換えを防ぐ）
    //   ② クロススロット重複: recentPostedTitles との稀少トークン共有 ≥ 2
    //      （Sol/Terra/Luna 等の同トピック記事を別スロットで重複投稿しない）
    const isBatchDuplicate = seenTitles
      .slice(recentPostedTitles.length)  // バッチ内タイトルのみ Jaccard で判定
      .some(prev => titleSimilarity(item.title, prev) >= SIMILARITY_THRESHOLD);
    if (isBatchDuplicate) {
      logger.info(`[バッチ内重複] スキップ: "${item.title.slice(0, 60)}"`);
      continue;
    }

    const isCrossSlot = recentPostedTitles
      .some(prev => isCrossSlotDuplicate(item.title, prev));
    if (isCrossSlot) {
      logger.info(`[クロススロット重複] スキップ: "${item.title.slice(0, 60)}"`);
      continue;
    }

    seenUrls.add(item.url);
    seenTitles.push(item.title);

    // フォールバックプールに全件追加（新しい順でソート済み）
    allUnposted.push(item);

    const cat = classifyItem(item.title, item.summary);
    if (!cat) continue; // テーマ分類できない場合はテーマグループには入れない

    if (!themeGroups.has(cat)) themeGroups.set(cat, []);
    themeGroups.get(cat)!.push(item);
  }

  // 新しい順にソート
  allUnposted.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  for (const [, items] of themeGroups) {
    items.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  }

  // ── 1st pass: 各テーマの最良1件を選択 ──
  const batch: PipelineItem[] = [];
  const selectedUrls = new Set<string>();

  for (const theme of themes) {
    const candidates = themeGroups.get(theme);
    if (!candidates || candidates.length === 0) {
      logger.info(`[${slot}] テーマ "${theme}": 候補記事なし → フォールバック待ち`);
      continue;
    }

    const item = candidates[0];
    const meta = CATEGORY_META[theme];

    batch.push({
      title: item.title,
      url: item.url,
      summary: item.summary,
      imageUrl: item.imageUrl,
      isEnglish: item.isEnglish,
      category: theme,
      hashtags: meta.hashtags,
    });
    selectedUrls.add(item.url);

    logger.info(
      `[${slot}] テーマ "${theme}" 選択: "${item.title.slice(0, 60)}${item.title.length > 60 ? '…' : ''}"`
    );
  }

  // ── 2nd pass: 目標件数に満たない場合、未選択の記事から補充 ──
  if (batch.length < targetCount) {
    const needed = targetCount - batch.length;
    logger.info(`[${slot}] ${batch.length}/${targetCount} 件 → フォールバックで ${needed} 件補充`);

    // フォールバックテーマプール: 5件目以降は SLOT_EXTENDED_THEMES を使用し
    // カテゴリカバレッジを拡大する（週次14/20カテゴリ達成を促進）
    const extendedThemes = SLOT_EXTENDED_THEMES[slot] ?? [];
    const fallbackThemePool: XCategory[] = [
      ...themes,        // 1st〜4th: 本来のスロットテーマを循環
      ...extendedThemes // 5th以降: 拡張テーマで多様性を確保
    ];

    let fallbackIdx = 0;

    for (const item of allUnposted) {
      if (batch.length >= targetCount) break;
      if (selectedUrls.has(item.url)) continue;

      const fallbackTheme = fallbackThemePool[fallbackIdx % fallbackThemePool.length];
      const fallbackMeta = CATEGORY_META[fallbackTheme];
      fallbackIdx++;

      batch.push({
        title: item.title,
        url: item.url,
        summary: item.summary,
        imageUrl: item.imageUrl,
        isEnglish: item.isEnglish,
        category: fallbackTheme,
        hashtags: fallbackMeta.hashtags,
      });
      selectedUrls.add(item.url);

      logger.info(
        `[${slot}] フォールバック補充 [${fallbackTheme}]: "${item.title.slice(0, 60)}${item.title.length > 60 ? '…' : ''}"`
      );
    }
  }

  const filled = batch.length >= targetCount ? '✅ 目標達成' : `⚠️ ${batch.length}/${targetCount} 件`;
  logger.info(`[${slot}] バッチ: ${batch.length} 件 / 目標 ${targetCount} 件 ${filled}`);
  return batch;
}
