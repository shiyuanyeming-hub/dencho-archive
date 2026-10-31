/**
 * 端末出力の整形。
 *
 * 日本語は全角文字（表示幅 2）を含むため、`String.prototype.padEnd` だけでは
 * 表がずれる。文字の表示幅を計算して揃える。
 */

/** 表示幅 2 として扱うコードポイントの範囲。 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** 1 文字の表示幅（全角 2 / 半角 1 / 結合文字 0）。 */
function charWidth(codePoint: number): number {
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) {
      return 2;
    }
  }
  return 1;
}

/** 文字列の表示幅。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    width += charWidth(codePoint);
  }
  return width;
}

/** 表示幅を基準に右側を空白で埋める。 */
export function padDisplay(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const padding = Math.max(0, width - displayWidth(text));
  return align === 'left' ? `${text}${' '.repeat(padding)}` : `${' '.repeat(padding)}${text}`;
}

/** 表を描く。 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const columns = headers.length;
  const widths = headers.map((header) => displayWidth(header));
  for (const row of rows) {
    for (let index = 0; index < columns; index += 1) {
      const cell = row[index] ?? '';
      widths[index] = Math.max(widths[index] ?? 0, displayWidth(cell));
    }
  }

  const border = (left: string, middle: string, right: string): string =>
    `${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`;

  const renderRow = (cells: readonly string[]): string => {
    const parts = widths.map((width, index) => ` ${padDisplay(cells[index] ?? '', width)} `);
    return `│${parts.join('│')}│`;
  };

  const lines: string[] = [];
  lines.push(border('┌', '┬', '┐'));
  lines.push(renderRow(headers));
  lines.push(border('├', '┼', '┤'));
  for (const row of rows) {
    lines.push(renderRow(row));
  }
  lines.push(border('└', '┴', '┘'));
  return lines.join('\n');
}

/** 金額を 3 桁区切りで表示する。 */
export function formatYen(amountYen: number): string {
  const negative = amountYen < 0;
  const digits = Math.abs(amountYen).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}¥${grouped}`;
}

/** バイト数を読みやすく表示する。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/** 真偽値の記号。 */
export function statusMark(ok: boolean): string {
  return ok ? '✓' : '✗';
}

/** 見出し付きの区切り線。 */
export function heading(title: string): string {
  return `\n${title}\n${'─'.repeat(Math.max(8, displayWidth(title)))}`;
}

/** 文字列を 1 行に畳む（表のセル用）。 */
export function oneLine(text: string, maxLength = 60): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (displayWidth(collapsed) <= maxLength) {
    return collapsed;
  }
  let result = '';
  let width = 0;
  for (const character of collapsed) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    const next = charWidth(codePoint);
    if (width + next > maxLength - 1) {
      break;
    }
    result += character;
    width += next;
  }
  return `${result}…`;
}
