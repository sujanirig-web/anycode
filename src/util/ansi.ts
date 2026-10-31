const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";

function paint(open: number, close: number): (text: string) => string {
  return (text: string) => (NO_COLOR ? text : `\u001b[${open}m${text}\u001b[${close}m`);
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

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}
