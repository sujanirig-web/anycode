const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Remove ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function codePointWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  // Combining marks and zero-width joiners.
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0;
  if (codePoint === 0x200b || codePoint === 0x200d) return 0;

  const wide =
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd);

  return wide ? 2 : 1;
}

/** Terminal columns occupied by `text` once ANSI sequences are ignored. */
export function stringWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

/** Cut plain text to `width` columns, appending an ellipsis when it overflows. */
export function truncateWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;

  let out = "";
  let used = 0;
  for (const char of text) {
    const next = codePointWidth(char.codePointAt(0) ?? 0);
    if (used + next > width - 1) break;
    out += char;
    used += next;
  }
  return `${out}…`;
}

/** Pad `text` with spaces so it occupies exactly `width` columns. */
export function padToWidth(text: string, width: number): string {
  const current = stringWidth(text);
  if (current >= width) return text;
  return text + " ".repeat(width - current);
}

/** Truncate from the left, keeping the tail (useful for paths). */
export function truncateLeft(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;

  const chars = [...text];
  let out = "";
  let used = 0;
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index] ?? "";
    const next = codePointWidth(char.codePointAt(0) ?? 0);
    if (used + next > width - 1) break;
    out = char + out;
    used += next;
  }
  return `…${out}`;
}
