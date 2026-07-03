/**
 * MicroApps Hub API ローダー
 *
 * /api/apps エンドポイントからアプリ一覧を取得する。
 * ネットワーク障害時はローカルキャッシュにフォールバック。
 *
 * APPS 配列の重複定義を解消し、apps-config.ts を Single Source of Truth にする。
 * PDCA-002 対応 (2026-06-30)
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const API_URL = 'https://micro-apps-hub-seven.vercel.app/api/apps';
const CACHE_FILE = path.join(process.cwd(), 'data', 'micro-apps-cache.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1時間

export interface MicroApp {
  slug: string;
  title: string;
  emoji: string;
  category: string;
  price: number;
  description: string;
  freeFeatures: string[];
  proFeatures: string[];
  /** 無料版の簡潔な説明（投稿文用）: freeFeatures[0] から生成 */
  free: string;
  /** Pro 版の簡潔な説明（投稿文用）: price + proFeatures[0] から生成 */
  pro: string;
  /** 配信ハッシュタグ用タグ（category から変換） */
  tag: string;
  /** Note 投稿用の詳細説明 */
  desc: string;
}

interface ApiResponse {
  apps: Array<{
    slug: string;
    title: string;
    emoji: string;
    category: string;
    price: number;
    description: string;
    freeFeatures: string[];
    proFeatures: string[];
  }>;
  count: number;
  updatedAt: string;
}

const CATEGORY_TAG: Record<string, string> = {
  game:     'ゲーム',
  tool:     'ツール',
  wellness: 'ウェルネス',
  training: 'トレーニング',
};

function toMicroApp(a: ApiResponse['apps'][0]): MicroApp {
  return {
    slug:         a.slug,
    title:        a.title,
    emoji:        a.emoji,
    category:     a.category,
    price:        a.price,
    description:  a.description,
    freeFeatures: a.freeFeatures,
    proFeatures:  a.proFeatures,
    free:         a.freeFeatures[0] ?? '無料で試せる',
    pro:          `¥${a.price}で${a.proFeatures[0] ?? 'Pro機能解放'}`,
    tag:          CATEGORY_TAG[a.category] ?? a.category,
    desc:         a.description,
  };
}

function loadCache(): { apps: MicroApp[]; fetchedAt: number } | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as {
      apps: MicroApp[];
      fetchedAt: number;
    };
    return raw;
  } catch {
    return null;
  }
}

function saveCache(apps: MicroApp[]): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ apps, fetchedAt: Date.now() }, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[micro-apps-loader] キャッシュ保存失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * MicroApps Hub API からアプリ一覧を取得する。
 * キャッシュが有効な場合はキャッシュを返す。
 * API 障害時はキャッシュにフォールバック。
 */
export async function loadMicroApps(): Promise<MicroApp[]> {
  // キャッシュチェック
  const cached = loadCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    logger.info(`[micro-apps-loader] キャッシュから ${cached.apps.length} 本を読み込み`);
    return cached.apps;
  }

  // API fetch
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as ApiResponse;
    // サーバーサイドで releaseStatus === 'live' フィルタ済みのため、クライアント側フィルタ不要
    const apps = data.apps.map(toMicroApp);
    saveCache(apps);
    logger.info(`[micro-apps-loader] API から ${apps.length} 本を取得`);
    return apps;
  } catch (err) {
    logger.warn(`[micro-apps-loader] API 取得失敗: ${err instanceof Error ? err.message : String(err)}`);
    // フォールバック: キャッシュ（期限切れでも使う）
    if (cached) {
      logger.info(`[micro-apps-loader] 古いキャッシュ(${cached.apps.length}本)にフォールバック`);
      return cached.apps;
    }
    throw new Error('MicroApps API が利用不可でキャッシュもありません');
  }
}

/**
 * 日付からローテーション対象アプリを選ぶ
 */
export function pickAppByDate(apps: MicroApp[], date: Date): MicroApp {
  const dayOfYear = Math.floor(
    (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86_400_000,
  );
  return apps[dayOfYear % apps.length];
}
