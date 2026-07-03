/**
 * 気休めネタ投稿モジュール
 *
 * 毎回 x:all を実行する際に 2件の気休めコンテンツを投稿する。
 * カテゴリ: 科学・自然・動物・スポーツ・ほっこり
 * 基準: 「いいね」「フーン」「なるほど」「かわいい」と感じるもの
 */
import Anthropic from '@anthropic-ai/sdk';
import { XPoster } from './poster';
import { fetchReliefItems, ReliefItem, ReliefCategory } from '../rss/relief-reader';
import { PostedUrlCache } from '../utils/posted-url-cache';
import { logAnalytics } from '../utils/analytics-logger';
import { logger } from '../utils/logger';

// ----------------------------------------------------------------
// カテゴリ別メタデータ（emoji / ラベル / ハッシュタグ）
// ----------------------------------------------------------------
const RELIEF_META: Record<ReliefCategory, { emoji: string; label: string; hashtags: string; angle: string }> = {
  science: {
    emoji: '🔬',
    label: '科学トリビア',
    hashtags: '#科学 #豆知識 #なるほど',
    angle: '「なるほど！」「フーン、そうなんだ」と思えるような面白い発見や事実を、分かりやすく親しみやすく伝える',
  },
  nature: {
    emoji: '🌿',
    label: '自然の不思議',
    hashtags: '#自然 #地球 #美しい',
    angle: '「すごい！」「地球って面白い」と思えるような自然現象や生態の不思議を、ワクワク感を込めて伝える',
  },
  animal: {
    emoji: '🐾',
    label: 'かわいい動物',
    hashtags: '#かわいい #動物 #癒し',
    angle: '「かわいい！」「癒される」と感じるような動物の行動・特徴・エピソードを、温かく伝える',
  },
  sports: {
    emoji: '🏆',
    label: 'スポーツ',
    hashtags: '#スポーツ #がんばれ #感動',
    angle: '「いいね！」「感動した」と思えるような選手の努力・活躍・感動エピソードを、明るく前向きに伝える',
  },
  heartwarming: {
    emoji: '💖',
    label: 'ほっこりネタ',
    hashtags: '#ほっこり #いいね #癒し',
    angle: '「いいね」「温かい気持ちになった」と感じるような出来事・エピソードを、共感しやすい言葉で伝える',
  },
};

// ----------------------------------------------------------------
// ツイート文生成（relief 専用プロンプト）
// ----------------------------------------------------------------
async function composeReliefTweet(
  anthropic: Anthropic,
  item: ReliefItem,
): Promise<string> {
  const meta = RELIEF_META[item.reliefCategory];

  const prompt = `あなたはSNS投稿ライターです。
以下のニュースを、読者が「いいね」「フーン」「なるほど」「かわいい」と自然に感じるような
温かみのあるX（旧Twitter）投稿文を日本語で作成してください。

【テーマ】${meta.emoji} ${meta.label}
【タイトル】${item.title}
【概要】${item.summary.slice(0, 200) || '（概要なし）'}
【元の言語】${isEnglish(item.title) ? '英語（内容は日本語で書くこと）' : '日本語'}

ルール:
- 日本語のみで書く（英語タイトルの場合は日本語に意訳してもよい）
- 投稿文は${meta.emoji}【${meta.label}】で始める
- 本文は2〜4行、親しみやすい表現
- 「${meta.angle}」という視点を意識する
- 暴力・不快・政治的に偏った表現は絶対に含めない
- 末尾のハッシュタグ行を追加: ${meta.hashtags}
- URLは投稿文に含めない（後で自動付与）
- 本文のみ出力（説明・前置き不要）`;

  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content.find(b => b.type === 'text')?.text?.trim() ?? '';
    if (text && !text.includes('申し訳') && !text.includes('できません')) {
      // URL + ハッシュタグを付与して最終フォーマットに整える
      return `${text}\n${item.url}`;
    }
  } catch (err) {
    logger.warn(`気休めツイート文生成失敗: ${err instanceof Error ? err.message : String(err)}`);
  }

  // フォールバック: タイトルベース
  return `${meta.emoji}【${meta.label}】\n${item.title.slice(0, 60)}\n${item.url}\n\n${meta.hashtags}`;
}

function isEnglish(text: string): boolean {
  if (!text) return false;
  const ascii = (text.match(/[a-zA-Z]/g) || []).length;
  const japanese = (text.match(/[぀-ヿ一-鿿]/g) || []).length;
  return ascii / text.length >= 0.4 && japanese / text.length < 0.1;
}

// ----------------------------------------------------------------
// カテゴリバランス選択
// ----------------------------------------------------------------
function selectBalancedItems(items: ReliefItem[], count: number): ReliefItem[] {
  const selected: ReliefItem[] = [];
  const usedCategories = new Set<ReliefCategory>();

  // まず異なるカテゴリから優先選択
  for (const item of items) {
    if (selected.length >= count) break;
    if (!usedCategories.has(item.reliefCategory)) {
      selected.push(item);
      usedCategories.add(item.reliefCategory);
    }
  }

  // 足りなければ残りから補充（カテゴリ重複OK）
  if (selected.length < count) {
    for (const item of items) {
      if (selected.length >= count) break;
      if (!selected.includes(item)) selected.push(item);
    }
  }

  return selected;
}

// ----------------------------------------------------------------
// 公開 API
// ----------------------------------------------------------------

/**
 * 気休めネタを count 件取得・投稿する。
 * post-all-slots.ts の全スロット完了後に呼ぶ。
 *
 * @param xPoster   共有ブラウザセッション（open 済みのもの）
 * @param anthropic Anthropic クライアント
 * @param count     投稿件数（デフォルト 2）
 * @param opts      dryRun: true なら投稿済みキャッシュを更新しない（既定: DRY_RUN 環境変数）
 */
export async function postReliefItems(
  xPoster: XPoster,
  anthropic: Anthropic,
  count = 2,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  const dryRun = opts.dryRun ?? process.env['DRY_RUN'] === 'true';
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`=== 気休めネタ投稿開始 (${count}件目標) ===`);
  logger.info('カテゴリ: 科学 / 自然 / 動物 / スポーツ / ほっこり');

  // 気休めは専用キャッシュで管理（AI ニュースとは別）
  const cache = new PostedUrlCache('data/x-relief-posted-urls.json');

  const allItems = await fetchReliefItems().catch(err => {
    logger.warn(`気休めネタ取得失敗: ${err instanceof Error ? err.message : String(err)}`);
    return [] as ReliefItem[];
  });

  if (allItems.length === 0) {
    logger.warn('気休めネタ: 取得できるアイテムがありません。スキップします。');
    return;
  }

  // 未投稿に絞る
  const unposted = allItems.filter(item => !cache.has(item.url));
  logger.info(`気休めネタ候補: ${allItems.length} 件 → 未投稿: ${unposted.length} 件`);

  if (unposted.length === 0) {
    logger.info('気休めネタ: 未投稿アイテムなし。スキップします。');
    return;
  }

  // カテゴリバランスを考慮して選択
  const selected = selectBalancedItems(unposted, count);
  logger.info(`気休めネタ選択: ${selected.map(i => `[${i.reliefCategory}] ${i.title.slice(0, 30)}`).join(' / ')}`);

  let successCount = 0;

  for (const item of selected) {
    logger.info(`\n--- [気休め:${item.reliefCategory}] ${item.title.slice(0, 60)} ---`);
    logger.info(`  ソース: ${item.sourceName} | URL: ${item.url.slice(0, 60)}`);

    const tweetText = await composeReliefTweet(anthropic, item);
    logger.info(`  ツイート文 (${tweetText.length}文字):\n${tweetText.slice(0, 120)}...`);

    const posted = await xPoster.tweet(tweetText, item.imageUrl);

    logAnalytics({
      postedAt: new Date().toISOString(),
      slot: 'relief',
      platform: 'x',
      theme: 'relief',
      // source フィールドで sub-category を記録（例: nhk_sports / thedodo / sciencedaily_animal）
      source: `${item.reliefCategory}:${item.sourceName}`,
      url: item.url,
      title: item.title,
      imageAttached: !!item.imageUrl && posted,
      success: posted,
      contentLength: tweetText.length,
    });

    if (posted) {
      successCount++;
      if (!dryRun) cache.add(item.url);
      logger.info(`  ✅ 投稿成功`);
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
    } else {
      logger.warn(`  ❌ 投稿失敗`);
    }
  }

  logger.info(`\n=== 気休めネタ投稿完了 — 成功: ${successCount}/${selected.length} ===`);
}
