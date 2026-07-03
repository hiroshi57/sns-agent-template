/**
 * Markdown → Note 投稿用テキスト変換
 *
 * note.com のエディタはプレーンテキスト挿入で動作するため、
 * Markdown 記法を読みやすいテキストに変換する。
 *
 * 変換ルール:
 *   # Title     → タイトル（別返却）
 *   ## H2       → ── H2テキスト ──（区切り付き）
 *   ### H3      → ▶ H3テキスト
 *   **bold**    → bold（記号除去）
 *   _italic_    → italic（記号除去）
 *   | table |   → 簡易テキスト表
 *   ```code```  → コードブロック（そのまま）
 *   [text](url) → text（URL除去。本文中のリンク）
 *   👉 [text](url) → 👉 URL（アフィリエイトリンクは URL を残す）
 *   ---         → 空行に変換
 */

export interface NoteContent {
  title: string;
  body: string;
}

/**
 * Markdown ファイル全体をパースして { title, body } を返す
 */
export function markdownToNote(markdown: string): NoteContent {
  const lines = markdown.split('\n');

  // 最初の H1 をタイトルとして抽出
  let title = '';
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('# ') && !title) {
      title = line.replace(/^#\s+/, '').trim();
      bodyStart = i + 1;
      break;
    }
  }

  // 本文行を変換
  const bodyLines: string[] = [];
  let inCodeBlock = false;
  let inTable = false;

  for (let i = bodyStart; i < lines.length; i++) {
    let line = lines[i];

    // コードブロック判定
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) bodyLines.push('');
      else bodyLines.push('');
      continue;
    }
    if (inCodeBlock) {
      bodyLines.push(line);
      continue;
    }

    // テーブル行
    if (line.trim().startsWith('|')) {
      if (!inTable) {
        inTable = true;
      }
      // ヘッダー区切り行（|---|---|）はスキップ
      if (/^\|[\s\-|:]+\|$/.test(line.trim())) continue;
      // テーブル行を簡易テキストへ変換（bold/italic も除去）
      const cells = line
        .split('|')
        .map(c => c.trim())
        .filter(c => c.length > 0)
        .map(c => c
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/__([^_]+)__/g, '$1')
          .replace(/_([^_]+)_/g, '$1')
        );
      bodyLines.push(cells.join(' / '));
      continue;
    } else {
      if (inTable) {
        inTable = false;
        bodyLines.push(''); // テーブル後に空行
      }
    }

    // 水平線
    if (/^---+$/.test(line.trim())) {
      bodyLines.push('');
      continue;
    }

    // 見出し H2
    if (line.startsWith('## ')) {
      const text = line.replace(/^##\s+/, '').trim();
      bodyLines.push('');
      bodyLines.push(`── ${text} ──`);
      bodyLines.push('');
      continue;
    }

    // 見出し H3
    if (line.startsWith('### ')) {
      const text = line.replace(/^###\s+/, '').trim();
      bodyLines.push('');
      bodyLines.push(`▶ ${text}`);
      continue;
    }

    // 見出し H4 以下
    if (line.startsWith('#### ')) {
      line = line.replace(/^####\s+/, '').trim();
    }

    // アフィリエイトリンク行（👉 [text](url) → 👉 url を残す）
    line = line.replace(/👉\s*\[([^\]]+)\]\(([^)]+)\)/g, '👉 $2');

    // 通常リンク（[text](url) → text）
    line = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Bold・Italic の記号除去
    line = line.replace(/\*\*([^*]+)\*\*/g, '$1');
    line = line.replace(/\*([^*]+)\*/g, '$1');
    line = line.replace(/__([^_]+)__/g, '$1');
    line = line.replace(/_([^_]+)_/g, '$1');

    // バッククォート inline code
    line = line.replace(/`([^`]+)`/g, '$1');

    bodyLines.push(line);
  }

  const body = bodyLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // 3連続以上の空行を2行に
    .trim();

  return { title, body };
}
