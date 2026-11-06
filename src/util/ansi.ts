const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";

const TRUECOLOR =
  /truecolor|24bit/i.test(process.env.COLORTERM ?? "") ||
  /truecolor|24bit/i.test(process.env.TERM ?? "") ||
  process.env.WT_SESSION !== undefined;

function paint(open: number | string, close: number | string): (text: string) => string {
  return (text: string) => (NO_COLOR ? text : `\u001b[${open}m${text}\u001b[${close}m`);
}

/** Map an RGB color onto the nearest xterm-256 palette entry. */
function toAnsi256(r: number, g: number, b: number): number {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  r = clamp(r);
  g = clamp(g);
  b = clamp(b);
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const level = (value: number) => Math.round((value / 255) * 5);
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

/**
 * Paint text in an RGB color. Uses 24-bit color when the terminal advertises
 * it, otherwise the closest xterm-256 entry so the gradient still works.
 */
export function rgb(r: number, g: number, b: number): (text: string) => string {
  if (TRUECOLOR) return paint(`38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}`, 39);
  return paint(`38;5;${toAnsi256(r, g, b)}`, 39);
}

export const color = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  italic: paint(3, 23),
  underline: paint(4, 24),
  inverse: paint(7, 27),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  blue: paint(34, 39),
  magenta: paint(35, 39),
  cyan: paint(36, 39),
  white: paint(37, 39),
  gray: paint(90, 39),
};

export const colorEnabled = !NO_COLOR;

/** Black canvas behind the conversation and the surrounding chrome. */
export function panelBackground(text: string): string {
  return NO_COLOR ? text : `\u001b[48;5;16m${text}\u001b[49m`;
}

/** Slightly lighter surface reserved for the composer. */
export function composerBackground(text: string): string {
  return NO_COLOR ? text : `\u001b[48;5;234m${text}\u001b[49m`;
}

/** Black background for chrome outside the composer. */
export function chromeBackground(text: string): string {
  return NO_COLOR ? text : `\u001b[48;5;16m${text}\u001b[49m`;
}

/** Remove ANSI escape sequences (useful for measuring visible width). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
