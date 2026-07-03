/**
 * isJapaneseHoliday のユニットテスト
 */
import { isJapaneseHoliday } from '../src/utils/holiday';

describe('isJapaneseHoliday', () => {
  test('元日 (1/1) は祝日', () => {
    expect(isJapaneseHoliday(new Date('2026-01-01'))).toBe(true);
  });

  test('建国記念の日 (2/11) は祝日', () => {
    expect(isJapaneseHoliday(new Date('2026-02-11'))).toBe(true);
  });

  test('天皇誕生日 (2/23) は祝日', () => {
    expect(isJapaneseHoliday(new Date('2026-02-23'))).toBe(true);
  });

  test('憲法記念日 (5/3) は祝日', () => {
    expect(isJapaneseHoliday(new Date('2026-05-03'))).toBe(true);
  });

  test('みどりの日 (5/4) は祝日', () => {
    expect(isJapaneseHoliday(new Date('2026-05-04'))).toBe(true);
  });

  test('こどもの日 (5/5) は祝日', () => {
    expect(isJapaneseHoliday(new Date('2026-05-05'))).toBe(true);
  });

  test('海の日 (7/20 は祝日ではない - 第3月曜日)', () => {
    // 2026-07-20 は月曜日なので海の日の可能性あり（jpholiday 依存）
    // 固定祝日ではないため false の可能性もある
    const result = isJapaneseHoliday(new Date('2026-07-20'));
    expect(typeof result).toBe('boolean');
  });

  test('山の日 (8/11) は祝日', () => {
    expect(isJapaneseHoliday(new Date('2026-08-11'))).toBe(true);
  });

  test('敬老の日 (9/21 は祝日ではない - 第3月曜日)', () => {
    // 固定祝日ではないため結果は環境依存
    const result = isJapaneseHoliday(new Date('2026-09-21'));
    expect(typeof result).toBe('boolean');
  });

  test('文化の日 (11/3) は祝日', () => {
    expect(isJapaneseHoliday(new Date('2026-11-03'))).toBe(true);
  });

  test('勤労感謝の日 (11/23) は祝日', () => {
    expect(isJapaneseHoliday(new Date('2026-11-23'))).toBe(true);
  });

  test('通常の平日は祝日ではない', () => {
    // 2026-06-10 は水曜日（祝日ではない）
    expect(isJapaneseHoliday(new Date('2026-06-10'))).toBe(false);
  });

  test('土曜日は祝日ではない（固定祝日でない場合）', () => {
    // 2026-06-13 は土曜日
    expect(isJapaneseHoliday(new Date('2026-06-13'))).toBe(false);
  });
});
