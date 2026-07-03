/**
 * トレンドハッシュタグ管理 (#45)
 *
 * X Trending API は有料のため手動で週次更新する方式を採用。
 * data/trend-hashtags.json に週次で更新したタグを保持し、
 * 各スロット投稿時に CATEGORY_META のデフォルトタグに追加する。
 *
 * 更新方法:
 *   1. X のトレンドを確認して data/trend-hashtags.json を編集
 *   2. または npm run pdca:analyze 後に strategy.json 経由で自動提案
 *
 * data/trend-hashtags.json のフォーマット:
 *   {
 *     "global": ["#ChatGPT", "#Gemini"],   // 全カテゴリ共通
 *     "model_release": ["#GPT5"],           // カテゴリ別（オプション）
 *     "updatedAt": "2026-06-10"
 *   }
 */
import fs from 'fs';
import path from 'path';
import { XCategory } from './x-category';
import { logger } from './logger';

const TREND_FILE = path.join(process.cwd(), 'data', 'trend-hashtags.json');
const MAX_TREND_TAGS = 2;          // 1投稿あたり追加するトレンドタグの上限
const MAX_STALENESS_DAYS = 14;     // この日数を超えたタグは期限切れとして無視

interface TrendHashtagsData {
  global?: string[];
  [category: string]: string[] | string | undefined;
  updatedAt?: string;
}

let _cache: TrendHashtagsData | null = null;

function load(): TrendHashtagsData {
  if (_cache) return _cache;
  try {
    if (!fs.existsSync(TREND_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(TREND_FILE, 'utf-8')) as TrendHashtagsData;

    // 鮮度チェック
    if (raw.updatedAt) {
      const age = (Date.now() - new Date(raw.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (age > MAX_STALENESS_DAYS) {
        logger.info(`trend-hashtags.json が ${Math.round(age)}日前のデータです。更新を推奨します。`);
      }
    }

    _cache = raw;
    return raw;
  } catch {
    return {};
  }
}

/**
 * カテゴリに対応するトレンドハッシュタグを返す。
 * global タグ + カテゴリ別タグを合わせて最大 MAX_TREND_TAGS 件。
 */
export function getTrendHashtags(category?: XCategory): string {
  const data = load();

  const tags: string[] = [
    ...(Array.isArray(data.global) ? data.global : []),
    ...(category && Array.isArray(data[category]) ? (data[category] as string[]) : []),
  ];

  // 重複除去して上限適用
  const unique = [...new Set(tags)].slice(0, MAX_TREND_TAGS);
  return unique.join(' ');
}

/**
 * 既存のハッシュタグ文字列にトレンドタグを追加して返す。
 * タグの重複は自動除去する。
 */
export function appendTrendHashtags(baseHashtags: string, category?: XCategory): string {
  const trend = getTrendHashtags(category);
  if (!trend) return baseHashtags;

  // 重複するタグを除外して追加
  const existing = new Set(baseHashtags.split(/\s+/).filter(Boolean));
  const newTags = trend.split(/\s+/).filter(t => !existing.has(t));

  return newTags.length > 0 ? `${baseHashtags} ${newTags.join(' ')}` : baseHashtags;
}

/**
 * trend-hashtags.json のテンプレートを生成して保存する。
 * npm run pdca:analyze 等から呼び出す想定。
 */
export function initTrendHashtagsFile(): void {
  if (fs.existsSync(TREND_FILE)) {
    logger.info('trend-hashtags.json は既に存在します');
    return;
  }
  const template: TrendHashtagsData = {
    global: ['#生成AI', '#AIニュース'],
    model_release: [],
    research_method: [],
    dev_tech: [],
    updatedAt: new Date().toISOString().slice(0, 10),
  };
  fs.mkdirSync(path.dirname(TREND_FILE), { recursive: true });
  fs.writeFileSync(TREND_FILE, JSON.stringify(template, null, 2));
  logger.info(`trend-hashtags.json を作成しました: ${TREND_FILE}`);
}
