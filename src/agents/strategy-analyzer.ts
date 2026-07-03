/**
 * 戦略アナライザー（PDCA の "Check & Act"）
 *
 * KpiReport を入力に Claude Sonnet が分析し、次サイクルの ContentStrategy を更新する。
 *
 * 分析軸:
 *   1. スロット別エラー率 → エラーが多いスロットの投稿間隔やリトライを提案
 *   2. スキップ率         → 高い場合は RSS ソース拡充・意見フィルタ緩和を提案
 *   3. カテゴリーバランス → 過剰/不足カテゴリを検出し slotThemeOverrides を自動生成
 *   4. カテゴリー数       → 未使用カテゴリに対応する RSS ソース boost を提案
 *   5. 全体投稿数         → 目標未達なら BATCH_SIZE 増加や RSS ソース追加を提案
 */
import Anthropic from '@anthropic-ai/sdk';
import { KpiReport } from './kpi-collector';
import { ContentStrategy, DEFAULT_STRATEGY, getEffectiveThemes } from '../utils/strategy-store';
import { SlotName, XCategory, SLOT_THEMES, X_CATEGORIES } from '../utils/x-category';
import { logger } from '../utils/logger';

// ----------------------------------------------------------------
// Claude プロンプト構築
// ----------------------------------------------------------------

function buildAnalysisPrompt(report: KpiReport, current: ContentStrategy): string {
  const kpiSummary = `
【直近 ${report.windowDays} 日間 KPI】
- 投稿成功: ${report.totalPosts} 件 / エラー: ${report.totalErrors} 件 / スキップ: ${report.totalSkips} 件
- 成功率: ${(report.overallSuccessRate * 100).toFixed(1)}%
- エラー率: ${(report.overallErrorRate * 100).toFixed(1)}% (目標: ${report.targetsStatus.errorRate.target * 100}%以下)
- スキップ率: ${(report.overallSkipRate * 100).toFixed(1)}% (目標: ${report.targetsStatus.skipRate.target * 100}%以下)
- 有効カテゴリ数: ${report.categoriesUsed.length}/20 (目標: ${report.targetsStatus.categoryCount.target}以上)
- カテゴリー偏り指数: ${report.categoryImbalanceScore.toFixed(2)} (0=完全均等, 高いほど偏り大)

【スロット別】
${(['slot07','slot11','slot12','slot14','slot17'] as SlotName[]).map((s) => {
  const k = report.bySlot[s];
  return `- ${s}: 実行${k.runs}回 成功${k.postsSucceeded} エラー${k.postsErrored} スキップ${k.postsSkipped}`;
}).join('\n')}

【カテゴリー使用状況】
- 過剰 TOP3: ${report.overrepresentedCategories.join(', ')}
- 不足 TOP3: ${report.underrepresentedCategories.join(', ')}
- 未使用: ${report.categoriesUnused.join(', ') || 'なし'}

【現在の戦略 (version ${current.version})】
- categoryWeights 設定済み: ${Object.keys(current.categoryWeights).join(', ') || 'なし'}
- slotThemeOverrides 設定済み: ${Object.keys(current.slotThemeOverrides).join(', ') || 'なし'}
- sourceBoosts: ${current.sourceBoosts.join(', ') || 'なし'}
- sourceSuppresses: ${current.sourceSuppresses.join(', ') || 'なし'}

【KPI 目標達成状況】
${Object.entries(report.targetsStatus).map(([k, v]) => `- ${v.met ? '✅' : '❌'} ${k}: 目標 ${v.target} 実績 ${v.actual}`).join('\n')}
`;

  const slotThemeInfo = (['slot07','slot11','slot12','slot14','slot17'] as SlotName[])
    .map((s) => `${s}: [${getEffectiveThemes(s, current).join(', ')}]`)
    .join('\n');

  return `あなたは X (Twitter) 自動投稿システムの PDCA 戦略アナライザーです。
以下の KPI データを分析し、次のサイクルで適用する戦略調整を JSON で出力してください。

${kpiSummary}

【現在のスロット別テーマ構成】
${slotThemeInfo}

【利用可能な全カテゴリ】
${X_CATEGORIES.join(', ')}

以下の JSON 形式で戦略調整を出力してください（コメントなし・説明なし、JSONのみ）:

{
  "insights": [
    "インサイト1（観察した問題点や発見）",
    "インサイト2",
    "インサイト3"
  ],
  "categoryWeights": {
    "カテゴリ名": 数値,
    ...
  },
  "slotThemeOverrides": {
    "slot07": ["cat1", "cat2", "cat3", "cat4"],
    ...
  },
  "sourceBoosts": ["ソース名", ...],
  "sourceSuppresses": ["ソース名", ...],
  "problemSummary": "問題点の1行サマリー（日本語）"
}

【調整ルール】
- categoryWeights: 不足カテゴリは 1.5〜2.0、過剰カテゴリは 0.5〜0.8、変更不要なら省略
- slotThemeOverrides: カテゴリを入れ替えるスロットのみ記載。変更不要なら省略
  - 不足カテゴリは別スロットのテーマに追加（同一カテゴリを2枠入れて増産も可）
  - 必ず4要素のリストにすること
- sourceBoosts: エラーが少なく高品質なソースを最大3件
- sourceSuppresses: エラー多発・低品質なソースを最大2件
- 変更不要な場合は空の object/array を返す
- kpiAchieved は出力しない（controller 側で判定）`;
}

// ----------------------------------------------------------------
// パース
// ----------------------------------------------------------------

interface AnalysisResult {
  insights: string[];
  categoryWeights: Partial<Record<XCategory, number>>;
  slotThemeOverrides: Partial<Record<SlotName, XCategory[]>>;
  sourceBoosts: string[];
  sourceSuppresses: string[];
  problemSummary?: string;
}

function parseAnalysisResult(text: string): AnalysisResult | null {
  try {
    // JSON ブロックを抽出
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as AnalysisResult;
    return parsed;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------
// メイン関数
// ----------------------------------------------------------------

/**
 * KpiReport を分析して ContentStrategy の更新差分を返す。
 * 失敗した場合は現在の strategy をそのまま返す（安全フォールバック）。
 */
export async function analyzeAndUpdateStrategy(
  anthropic: Anthropic,
  report: KpiReport,
  current: ContentStrategy
): Promise<ContentStrategy> {
  logger.info('[PDCA] 戦略分析開始...');

  const prompt = buildAnalysisPrompt(report, current);

  let result: AnalysisResult | null = null;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    logger.info(`[PDCA] Claude 応答:\n${text.slice(0, 500)}...`);

    result = parseAnalysisResult(text);
    if (!result) {
      logger.warn('[PDCA] JSON パース失敗 → 戦略を変更せずに維持');
      return current;
    }
  } catch (err) {
    logger.warn(`[PDCA] Claude 呼び出しエラー: ${err instanceof Error ? err.message : err}`);
    return current;
  }

  // ── #25: カテゴリーバランス自動調整（決定論的補正）──
  // Claude の提案とは独立して、偏りが激しい場合に強制的にウェイトを補正する。
  // categoryImbalanceScore > 1.0 のとき:
  //   - 過剰 TOP3: 現ウェイト or 0.5 の小さい方
  //   - 不足 TOP3: 現ウェイト or 1.5 の大きい方
  if (report.categoryImbalanceScore > 1.0) {
    logger.info(
      `[PDCA] カテゴリー偏り指数 ${report.categoryImbalanceScore.toFixed(2)} > 1.0 → 自動バランス補正を適用`
    );
    const autoWeights: Partial<Record<XCategory, number>> = { ...(result.categoryWeights ?? {}) };

    for (const cat of report.overrepresentedCategories) {
      const current_w = autoWeights[cat] ?? (current.categoryWeights[cat] ?? 1.0);
      autoWeights[cat] = Math.min(current_w, 0.5);
    }
    for (const cat of report.underrepresentedCategories) {
      const current_w = autoWeights[cat] ?? (current.categoryWeights[cat] ?? 1.0);
      autoWeights[cat] = Math.max(current_w, 1.5);
    }
    result.categoryWeights = { ...result.categoryWeights, ...autoWeights };
  }

  // スロット別テーマ上書きのバリデーション（各スロットが必ず4要素）
  const validatedOverrides: Partial<Record<SlotName, XCategory[]>> = {};
  for (const [slot, themes] of Object.entries(result.slotThemeOverrides ?? {})) {
    if (Array.isArray(themes) && themes.length === 4) {
      const validThemes = themes.filter((t) => X_CATEGORIES.includes(t as XCategory)) as XCategory[];
      if (validThemes.length === 4) {
        validatedOverrides[slot as SlotName] = validThemes;
      }
    }
  }

  // カテゴリウェイトのバリデーション（0.0〜3.0）
  const validatedWeights: Partial<Record<XCategory, number>> = {};
  for (const [cat, weight] of Object.entries(result.categoryWeights ?? {})) {
    if (X_CATEGORIES.includes(cat as XCategory) && typeof weight === 'number') {
      validatedWeights[cat as XCategory] = Math.max(0, Math.min(3.0, weight));
    }
  }

  const updated: ContentStrategy = {
    ...current,
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
    insights: result.insights ?? current.insights,
    categoryWeights: { ...current.categoryWeights, ...validatedWeights },
    slotThemeOverrides: { ...current.slotThemeOverrides, ...validatedOverrides },
    sourceBoosts: result.sourceBoosts ?? current.sourceBoosts,
    sourceSuppresses: result.sourceSuppresses ?? current.sourceSuppresses,
    problemSummary: result.problemSummary,
    kpiAchieved: report.allTargetsMet,
  };

  logger.info(
    `[PDCA] 戦略更新完了 → version ${updated.version}` +
    ` / インサイト ${updated.insights.length} 件` +
    ` / カテゴリウェイト変更 ${Object.keys(validatedWeights).length} 件` +
    ` / テーマ上書き ${Object.keys(validatedOverrides).length} スロット`
  );

  return updated;
}
