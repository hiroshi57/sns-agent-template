import Anthropic from '@anthropic-ai/sdk';
import { ArticleContent } from '../scraper/article';
import { XCategory, CATEGORY_META, SlotName } from './x-category';
import { filterPii, maskPiiByPattern } from './pii-filter';
import { tagPrefix } from './post-tag';
import { appendTrendHashtags } from './trend-hashtags';
import { logger } from './logger';

const DEFAULT_HASHTAGS = '#AI #人工知能 #テクノロジー';

/** スロット別トーン定義 */
const SLOT_TONE: Record<SlotName, string> = {
  slot07: '通勤中のビジネスパーソンが読むことを意識して、今日の仕事に役立つ視点・ビジネスへの示唆を1文で添えること。テンションは前向きでエネルギッシュに。',
  slot11: '午前の業務の隙間に読む層向けに、技術的な新しさ・驚きを伝えること。「〜が登場」「〜が可能に」など変化を明確に示す表現を使う。',
  slot12: 'ランチタイムに軽く読める長さで、データや数字・研究結果を1つ具体的に引用して説得力を出すこと。',
  slot14: '午後の業務再開前に読む層向けに、業界や自社への影響を考えさせる問いかけや示唆を入れること。「〜な時代が来る？」「あなたの会社は対応できている？」などの問いかけ表現もOK。',
  slot17: '退勤・帰宅途中のエンジニア向けに、実装のコツ・使えるツール・コードへの言及を入れること。「試してみた」「使えそう」など行動を促す言葉を加える。',
};

/** composeTweet のオプション */
export interface ComposeTweetOpts {
  /** テーマカテゴリ（指定時はツイート冒頭に絵文字ラベルを付与） */
  category?: XCategory;
  /** カスタムハッシュタグ（指定時は DEFAULT_HASHTAGS を上書き） */
  hashtags?: string;
  /** 実行スロット（時間帯別トーン制御に使用） */
  slot?: SlotName;
}

// 後方互換のため HASHTAGS は残す（既存コードがある場合）
const HASHTAGS = DEFAULT_HASHTAGS;

/**
 * テキストが主に英語か判定する。
 * 英字が全体の 40% 以上 かつ 日本語文字が 10% 未満 → 英語記事と判定。
 */
function isEnglishTitle(title: string): boolean {
  if (!title || title.length === 0) return false;
  const asciiLetters = (title.match(/[a-zA-Z]/g) || []).length;
  const japaneseChars = (title.match(/[぀-ヿ一-鿿]/g) || []).length;
  return asciiLetters / title.length >= 0.4 && japaneseChars / title.length < 0.1;
}

/**
 * Chatwork 記法・山括弧タグを除去する（＜共有＞ ＜返信＞ など）
 */
function sanitizeTweetBody(text: string): string {
  return text
    .replace(/＜[^＞]*＞/g, '')  // 全角 ＜...＞
    .replace(/<[^>]*>/g, '')      // 半角 <...>
    .trim();
}

/**
 * 記事からツイート文を生成する（Claude Haiku）
 *
 * 【英語記事の場合】
 *   1行目: カテゴリラベル（オプション）
 *   2行目: 元の英語タイトル（翻訳・加工なし・原文のまま）
 *   3行目: 日本語での内容要約
 *
 * 【日本語記事の場合】
 *   1行目: カテゴリラベル（オプション）
 *   2行目以降: 日本語で要約
 *
 * 上限: 280文字（URL=23 + ハッシュタグ + ラベル分を差し引いた文字数以内）
 */
export async function composeTweet(
  anthropic: Anthropic,
  article: ArticleContent,
  opts?: ComposeTweetOpts
): Promise<string> {
  const urlLen = 23; // X は全 URL を 23文字としてカウント

  // タグ + カテゴリラベル（例: "#業界動向\n📈【トレンド】\n"）
  const categoryMeta = opts?.category ? CATEGORY_META[opts.category] : null;
  const tagPart = tagPrefix(opts?.category);
  const labelPart = categoryMeta
    ? `${categoryMeta.emoji}【${categoryMeta.label}】\n`
    : '';
  const prefix = `${tagPart}${labelPart}`;

  // ハッシュタグ（トレンドタグを追加 #45）
  const baseHashtags = opts?.hashtags ?? HASHTAGS;
  const hashtagStr = appendTrendHashtags(baseHashtags, opts?.category);
  const hashtagPart = `\n\n${hashtagStr}`;

  /**
   * X の文字数カウント:
   *   - ASCII 1文字 = 1
   *   - 日本語・全角 1文字 = 2 (ただし X API の weighted_entities では 2)
   *   - URL = 23 固定
   * ここでは保守的に 日本語=2文字 として計算し、上限を 140 weighted characters に設定
   * (280 weighted = 140 日本語文字 相当)
   */
  function xWeightedLen(text: string): number {
    let count = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      // U+0000–U+10FF 以下の Latin/Arabic/Thai 等も X では weight 2 になるため
      // U+007F（ASCII 印字可能）を境界として使用。制御文字(0x00-0x1F)は 0 扱いで安全側に倒す
      count += cp <= 0x007F ? 1 : 2;
    }
    return count;
  }

  // prefix + hashtagPart + URL(23) + 改行(1) の weighted 消費量を計算
  const fixedWeighted = xWeightedLen(prefix) + xWeightedLen(hashtagPart) + urlLen + 1;
  // 残り weighted を日本語文字数に換算（1日本語文字=2 で割る、切り捨て）
  const maxBodyWeighted = 280 - fixedWeighted;
  // Claude への指示用: 安全のため 10 weighted 分のバッファを取る
  const maxBodyLen = Math.floor((maxBodyWeighted - 10) / 2);

  const english = isEnglishTitle(article.title);
  logger.info(`言語判定: ${english ? '英語' : '日本語'} — "${article.title.slice(0, 40)}"`);

  // スロット別トーン指示
  const slotTone = opts?.slot ? `\n- 【時間帯トーン】${SLOT_TONE[opts.slot]}` : '';

  // カテゴリ切り口
  const angleNote = categoryMeta
    ? `\n- 特に「${categoryMeta.angle}」という視点で書くこと`
    : '';

  // インプレッション最大化ルール（全スロット共通）
  const impressionRules = `
【冒頭フック（最重要）】
- 1文目でスクロールを止める。「何が起きたか」「何が変わったか」を即座に伝える
- 良い例: 「GPT-5、推論速度が従来比3倍に。」「Anthropicが新モデルを無料公開。」
- 悪い例: 「〜について解説します」「〜の記事を紹介します」（前置きNG）
【数字・具体性】
- 数字・社名・モデル名・比率など具体的な事実を必ず1つ入れる
- 「大幅に向上」→「速度3倍・コスト50%削減」のように具体化
【日本ビジネスコンテキスト（必須）】
- 以下のいずれか1つ以上を必ず本文に含める:
  ①日本の具体的な業界名（製造業・BPO・地方銀行・SIer・商社・小売業 等）
  ②日本で使われる具体的なツール名（kintone・Slack・Salesforce・SAP・freee・弥生 等）
  ③日本の具体的な職種・業務名（審査業務・書類処理・受託開発・品質検査 等）
- 対比構造で「格差感」を出す: 「〇〇できる組織 vs 出遅れる組織」「早期採用企業とそうでない企業」
- 変化を示す言葉: 「格差が生まれる」「構造が変わる」「変曲点」「二極化が進む」「業界を問わず影響が出る」
【So what?（締め）】
- 最後の1文で日本の特定業界・職種への影響を示唆して締める
- 「〇〇業界はこの流れを無視できない」「SIerや製造業には直接影響する」など具体的に
【エンゲージメントパターン（どれか1つ使う）】
- 問いかけ: 「あなたの会社は対応できている？」
- 比較: 「内製できる組織とベンダー依存の組織で〜が変わる」
- 意外性: 「実は〜だった」「意外にも〜」
【高インプレッション事例（参考パターン）】
パターンA: [技術効果]+[日本業界名]+[構造変化]
 例「170言語対応は日本のBPO業界の書類処理を直撃する。信頼度スコア付きなら人間確認が最小化でき、BPO業界の構造を変えうる。」
パターンB: [課題特定]+[具体ツール]+[対比格差]
 例「kintone等との連携基盤を内製できる組織とベンダー依存の組織で、AI活用の格差が決定的になりつつある。」`;

  let tweetBody = '';
  let usedTitleFallback = false;
  try {
    if (english) {
      // ── 英語記事: タイトルは英語のまま、内容は自然な日本語で要約 (#44) ──
      const titleLine = article.title.slice(0, 100).trim();
      const maxSummaryLen = maxBodyLen - titleLine.length - 1;

      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        messages: [
          {
            role: 'user',
            content: `以下の英語AI記事を日本語X（Twitter）投稿用に${maxSummaryLen}文字以内で要約してください。

【最優先: インプレッションを最大化する構成】
1文目（フック）: 「何が起きたか・何が変わったか」を断言口調で即座に伝える
2〜3文目（内容）: 数字・社名・具体的な改善点を1つ以上含める
最終文（So what?）: 日本のビジネス/エンジニアへの示唆・行動を促す言葉

【文体ルール】
- 直訳・機械翻訳的な表現NG、自然な日本語で書く
- 「〜の可能性があります」「〜と言われています」などの曖昧表現NG
- 英語の専門用語はそのまま使う（LLM、RAG、Fine-tuning、AGI など）${angleNote}${slotTone}${impressionRules}

【出力形式】
- 日本語のみ（URLとハッシュタグは後で自動付与するため不要）
- 前置き・説明なしで本文のみ出力
- 個人情報（氏名・連絡先・住所）を絶対に含めないこと

タイトル: ${article.title}
概要: ${article.summary.slice(0, 400)}`,
          },
        ],
      });

      const japaneseSummary = sanitizeTweetBody(
        msg.content[0].type === 'text' ? msg.content[0].text.trim() : ''
      ).slice(0, maxSummaryLen);
      tweetBody = `${titleLine}\n${japaneseSummary}`;
    } else {
      // ── 日本語記事: 全文を日本語で要約 ──
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        messages: [
          {
            role: 'user',
            content: `以下の記事をX（Twitter）投稿用に${maxBodyLen}文字以内で要約してください。

【最優先: インプレッションを最大化する構成】
1文目（フック）: 「何が起きたか・何が変わったか」を断言口調で即座に伝える。前置きNG
2〜3文目（内容）: 数字・社名・具体的な事実を1つ以上含める
最終文（So what?）: 読者（ビジネスパーソン/エンジニア）への示唆・行動を促す1文

【禁止事項】
- 「〜について解説します」「〜の記事を紹介します」などの前置きNG
- 「〜の可能性があります」「〜と言われています」など曖昧表現NG
- ハッシュタグ・URL不要（後で自動付与）
- 個人名・メールアドレス・電話番号・住所・社内情報など個人情報を絶対に含めないこと
- AI・テクノロジー以外の内容は含めないこと${angleNote}${slotTone}${impressionRules}

タイトル: ${article.title}
概要: ${article.summary.slice(0, 300)}`,
          },
        ],
      });

      tweetBody = sanitizeTweetBody(
        msg.content[0].type === 'text' ? msg.content[0].text.trim() : ''
      );
    }
  } catch (err) {
    logger.warn(`ツイート文生成失敗 → タイトルで代替: ${err instanceof Error ? err.message : String(err)}`);
    tweetBody = sanitizeTweetBody(article.title);
    usedTitleFallback = true;
  }

  // Claude が「本文がない」「申し訳ありません」等のメタ返答をした場合はタイトルで代替
  const META_PATTERNS = [
    '申し訳', '本文をご提供', '記事の本文が', '要約するには',
    '詳細な内容が', '実際の記事内容が', '情報をご提供',
  ];
  if (!tweetBody || META_PATTERNS.some((p) => tweetBody.includes(p))) {
    logger.warn('Claude がメタ返答 → タイトルで代替');
    tweetBody = sanitizeTweetBody(article.title);
    usedTitleFallback = true;
  }

  // 文字数オーバー対策（weighted でトリミング）
  let weighted = 0;
  let sliceEnd = 0;
  for (const ch of tweetBody) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = cp <= 0x10FF ? 1 : 2;
    if (weighted + w > maxBodyWeighted - 10) break;
    weighted += w;
    sliceEnd += ch.length;
  }
  tweetBody = tweetBody.slice(0, sliceEnd);

  // ── PII フィルタリング（2段階）──
  // Step1: 正規表現で確実に除去（メール・電話番号・郵便番号など）
  tweetBody = maskPiiByPattern(tweetBody);
  // Step2: Claude で文脈的な個人情報（人名・社内情報など）を除去
  tweetBody = await filterPii(anthropic, tweetBody);

  // PII 除去後に weighted カウントで再トリミング（文字数ではなく weighted を使う）
  // ※ tweetBody.slice(0, maxBodyLen) は ASCII/日本語混在時に不正確なため修正
  {
    let wPii = 0, slicePii = 0;
    for (const ch of tweetBody) {
      const cp = ch.codePointAt(0) ?? 0;
      const w = cp <= 0x10FF ? 1 : 2;
      if (wPii + w > maxBodyWeighted - 10) break;
      wPii += w;
      slicePii += ch.length;
    }
    tweetBody = tweetBody.slice(0, slicePii);
  }

  // 短文フィルタ: Claude 生成テキストが50文字未満は品質不足として除外
  // タイトルフォールバック時はスキップ（タイトルが短い記事まで除外しない）
  if (!usedTitleFallback && tweetBody.length < 50) {
    logger.warn(`短文ツイートを除外 (${tweetBody.length}文字 < 50文字)`);
    throw new Error('TWEET_TOO_SHORT');
  }

  // 最終フォーマット:
  // [カテゴリラベル（あれば）]
  // [英語タイトル（英語記事の場合）]
  // [本文]
  // [URL]
  // [ハッシュタグ]
  const tweet = `${prefix}${tweetBody}\n${article.url}${hashtagPart}`;

  // ── 最終 280 weighted チェック ──
  const bodyWeighted = xWeightedLen(`${prefix}${tweetBody}\n`) + urlLen + xWeightedLen(hashtagPart);
  if (bodyWeighted > 280) {
    // 万が一 280 を超えた場合は本文をさらにトリミングして安全側に倒す
    logger.warn(`ツイート文字数オーバー (${bodyWeighted}/280 weighted) → 強制トリミング`);
    const excess = bodyWeighted - 280 + 5; // 5 weighted のバッファ
    let wTrim = 0, sliceTrim = tweetBody.length;
    // 末尾から excess weighted 分を削る
    for (let i = tweetBody.length - 1; i >= 0 && wTrim < excess; i--) {
      const cp = tweetBody.codePointAt(i) ?? 0;
      wTrim += cp <= 0x10FF ? 1 : 2;
      sliceTrim = i;
    }
    tweetBody = tweetBody.slice(0, sliceTrim);
  }

  const finalTweet = `${prefix}${tweetBody}\n${article.url}${hashtagPart}`;
  const finalWeighted = xWeightedLen(`${prefix}${tweetBody}\n`) + urlLen + xWeightedLen(hashtagPart);
  logger.info(`ツイート文生成: ${finalTweet.length}文字 (X換算≈${finalWeighted}/280 weighted) / カテゴリ: ${opts?.category ?? 'なし'}`);
  return finalTweet;
}
