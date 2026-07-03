/**
 * 日本の祝日判定ユーティリティ
 *
 * 判定方法:
 *  1. `jpholiday` パッケージが利用可能なら使用（正確）
 *  2. なければ固定祝日のみの簡易判定にフォールバック
 *
 * ※ 振替休日・山の日の移動なども含めて正確に判定するには
 *    `npm install jpholiday` を実行してください。
 */

let jpholiday: { isHoliday: (date: Date) => string | false } | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  jpholiday = require('jpholiday') as typeof jpholiday;
} catch {
  // jpholiday が未インストールの場合は固定祝日のみで判定
}

/**
 * 固定祝日（月/日）のリスト
 * 振替休日・春分の日・秋分の日は年によって変わるため別途計算
 */
const FIXED_HOLIDAYS: [number, number][] = [
  [1, 1],   // 元日
  [2, 11],  // 建国記念の日
  [2, 23],  // 天皇誕生日
  [4, 29],  // 昭和の日
  [5, 3],   // 憲法記念日
  [5, 4],   // みどりの日
  [5, 5],   // こどもの日
  [8, 11],  // 山の日
  [11, 3],  // 文化の日
  [11, 23], // 勤労感謝の日
];

/** 春分の日（概算） */
function vernalEquinox(year: number): number {
  if (year <= 1979) return Math.floor(20.8357 + 0.242194 * (year - 1980) - Math.floor((year - 1983) / 4));
  if (year <= 2099) return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  return Math.floor(21.851 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 秋分の日（概算） */
function autumnalEquinox(year: number): number {
  if (year <= 1979) return Math.floor(23.2588 + 0.242194 * (year - 1980) - Math.floor((year - 1983) / 4));
  if (year <= 2099) return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  return Math.floor(24.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 指定日が第N月曜かを確認して祝日名を返す（成人の日・海の日・敬老の日・スポーツの日） */
function nthMondayHoliday(date: Date): string | null {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const dow = date.getDay();
  if (dow !== 1) return null; // 月曜でなければ対象外

  const nthMonday = Math.ceil(d / 7);
  if (m === 1 && nthMonday === 2) return '成人の日';
  if (m === 7 && nthMonday === 3) return '海の日';
  if (m === 9 && nthMonday === 3) return '敬老の日';
  if (m === 10 && nthMonday === 2) return 'スポーツの日';
  return null;
}

/**
 * 指定した日付が日本の祝日かどうかを判定する
 * @param date 判定する日付（JST を想定）
 * @returns 祝日なら true
 */
export function isJapaneseHoliday(date: Date): boolean {
  // jpholiday があれば正確な判定を使う
  if (jpholiday) {
    return jpholiday.isHoliday(date) !== false;
  }

  // ── 簡易判定 ──
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  // 固定祝日
  if (FIXED_HOLIDAYS.some(([m, d]) => m === month && d === day)) return true;

  // 春分の日
  if (month === 3 && day === vernalEquinox(year)) return true;
  // 秋分の日
  if (month === 9 && day === autumnalEquinox(year)) return true;

  // 第 N 月曜日の祝日
  if (nthMondayHoliday(date)) return true;

  // 振替休日（日曜が祝日の場合、翌月曜）
  const yesterday = new Date(date);
  yesterday.setDate(day - 1);
  if (date.getDay() === 1 && isJapaneseHoliday(yesterday)) return true;

  return false;
}
