import { color, rgb } from "../util/ansi.js";

/**
 * Braille infinity marks built from one lemniscate curve.
 *
 * Two grids share the same path: the wide brand mark on the empty session and
 * the slightly narrower working icon shown in the status strip. Both keep three
 * rows so the waist between the lobes stays thin; at two rows the lobes merge
 * into a bridge that reads as a pair of glasses.
 */
const BRAND_WIDTH = 15;
const BRAND_HEIGHT = 3;
const ICON_WIDTH = 13;
const ICON_HEIGHT = 3;
/** Bigger working icon for wide terminals, so the loader reads at a glance. */
export const BIG_ICON_WIDTH = 21;
const BIG_ICON_HEIGHT = 5;
const PATH_SAMPLES = 720;

/** Time for the working infinity to drift from purple to red and back again. */
export const INFINITY_COLOR_CYCLE_MS = 45_000;

/** Time for the highlight to travel once around the working infinity. */
export const INFINITY_SPIN_MS = 1_800;

/** Fraction of the loop covered by the fading tail behind the highlight. */
const GLOW_TAIL = 0.13;

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const NODE_PURPLE: RgbColor = { r: 168, g: 85, b: 247 };
const NODE_RED: RgbColor = { r: 239, g: 68, b: 68 };
const NODE_HIGHLIGHT: RgbColor = { r: 250, g: 246, b: 255 };

/** Braille bit for a sub-dot at (dx, dy) inside a 2x4 cell. */
const DOT_BITS: readonly (readonly number[])[] = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

interface DotPoint {
  /** Dot-space column. */
  x: number;
  /** Dot-space row, top-down. */
  y: number;
}

/** Point on a horizontal Bernoulli lemniscate, mapped into dot space. */
function lemniscate(t: number, dotWidth: number, dotHeight: number): DotPoint {
  const denominator = 1 + Math.sin(t) ** 2;
  const x = Math.cos(t) / denominator;
  const y = (Math.sin(t) * Math.cos(t)) / denominator;
  return {
    x: ((x + 1) / 2) * (dotWidth - 1),
    y: ((0.45 - y) / 0.9) * (dotHeight - 1),
  };
}

/** Precompute a braille path grid so rendering is a pure map over the cells. */
function buildPath(width: number, height: number): number[][] {
  const dotWidth = width * 2;
  const dotHeight = height * 4;
  const cells = Array.from({ length: height }, () => Array<number>(width).fill(0));
  for (let sample = 0; sample < PATH_SAMPLES; sample++) {
    const point = lemniscate((sample / PATH_SAMPLES) * Math.PI * 2, dotWidth, dotHeight);
    const dotX = Math.round(point.x);
    const dotY = Math.round(point.y);
    const cellX = Math.floor(dotX / 2);
    const cellY = Math.floor(dotY / 4);
    const row = cells[cellY];
    if (!row || row[cellX] === undefined) continue;
    row[cellX]! |= DOT_BITS[dotX % 2]![dotY % 4] ?? 0;
  }
  return cells;
}

const BRAND_CELLS = buildPath(BRAND_WIDTH, BRAND_HEIGHT);
const ICON_CELLS = buildPath(ICON_WIDTH, ICON_HEIGHT);
const BIG_ICON_CELLS = buildPath(BIG_ICON_WIDTH, BIG_ICON_HEIGHT);

interface GlowTrackCell {
  row: number;
  column: number;
  /** Path positions that map to this braille cell, in 0..1 loop units. */
  angles: number[];
}

/** Precompute which loop positions light each braille cell. */
function buildGlowTrack(width: number, height: number): GlowTrackCell[] {
  const dotWidth = width * 2;
  const dotHeight = height * 4;
  const cells = new Map<string, GlowTrackCell>();

  for (let sample = 0; sample < PATH_SAMPLES; sample++) {
    const angle = sample / PATH_SAMPLES;
    const point = lemniscate(angle * Math.PI * 2, dotWidth, dotHeight);
    const column = Math.floor(Math.round(point.x) / 2);
    const row = Math.floor(Math.round(point.y) / 4);
    if (row < 0 || row >= height || column < 0 || column >= width) continue;

    const key = `${row}:${column}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { row, column, angles: [] };
      cells.set(key, cell);
    }
    cell.angles.push(angle);
  }

  return [...cells.values()];
}

const ICON_GLOW_TRACK = buildGlowTrack(ICON_WIDTH, ICON_HEIGHT);
const BIG_ICON_GLOW_TRACK = buildGlowTrack(BIG_ICON_WIDTH, BIG_ICON_HEIGHT);

function toLine(rowCells: readonly number[]): string {
  return rowCells
    .map((bits) => (bits === 0 ? " " : String.fromCharCode(0x2800 + bits)))
    .join("");
}

function mixColor(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount),
  };
}

/**
 * Color for the working infinity at a point in time. A cosine ease keeps the
 * transition soft at both ends: purple -> red -> purple over
 * {@link INFINITY_COLOR_CYCLE_MS}.
 */
export function nodeColorAt(elapsedMs: number): RgbColor {
  const phase = 0.5 - 0.5 * Math.cos((elapsedMs / INFINITY_COLOR_CYCLE_MS) * Math.PI * 2);
  return mixColor(NODE_PURPLE, NODE_RED, phase);
}

export interface InfinityGlow {
  row: number;
  column: number;
  /** 0..1; 1 at the head of the travelling highlight. */
  intensity: number;
}

/**
 * Cells lit by the moving highlight at a point in time. The head is at full
 * intensity and the tail fades smoothly behind it, wrapping around the loop.
 */
export function infinityGlow(elapsedMs: number): InfinityGlow[] {
  return infinityGlowForTrack(ICON_GLOW_TRACK, elapsedMs);
}

/**
 * Cells lit by the moving highlight for a given precomputed track.
 */
function infinityGlowForTrack(track: GlowTrackCell[], elapsedMs: number): InfinityGlow[] {
  const wrapped = ((elapsedMs % INFINITY_SPIN_MS) + INFINITY_SPIN_MS) % INFINITY_SPIN_MS;
  const phase = wrapped / INFINITY_SPIN_MS;
  const lit: InfinityGlow[] = [];

  for (const cell of track) {
    let distance = Infinity;
    for (const angle of cell.angles) {
      const behind = (phase - angle + 1) % 1;
      if (behind < distance) distance = behind;
    }
    if (distance > GLOW_TAIL) continue;

    const falloff = 1 - distance / GLOW_TAIL;
    lit.push({
      row: cell.row,
      column: cell.column,
      intensity: falloff * falloff * (3 - 2 * falloff),
    });
  }

  return lit;
}

/** Visible width of the brand mark in terminal columns. */
export const INFINITY_WIDTH = BRAND_WIDTH;

/** Visible width of the working icon in terminal columns. */
export const INFINITY_ICON_WIDTH = ICON_WIDTH;

/**
 * Static infinity mark for the empty-session brand. It leaves out any node or
 * trail so it reads as a logo rather than a progress indicator.
 */
export function renderInfinityMark(): string[] {
  return BRAND_CELLS.map((rowCells) => color.bold(color.magenta(toLine(rowCells))));
}

/**
 * Working infinity icon for the status strip. The mark keeps its pulsing color
 * while a soft, fading highlight travels around the path, so the loader reads
 * as one polished object instead of a bullet sliding over the logo.
 */
export function renderInfinityIcon(elapsedMs: number): string[] {
  const pulse = nodeColorAt(elapsedMs);
  const glow = new Map(
    infinityGlow(elapsedMs).map(
      (cell) => [`${cell.row}:${cell.column}`, cell.intensity] as const,
    ),
  );

  return ICON_CELLS.map((rowCells, row) =>
    rowCells
      .map((bits, column) => {
        if (bits === 0) return " ";
        const intensity = glow.get(`${row}:${column}`) ?? 0;
        const tint = mixColor(pulse, NODE_HIGHLIGHT, intensity);
        return color.bold(rgb(tint.r, tint.g, tint.b)(String.fromCharCode(0x2800 + bits)));
      })
      .join(""),
  );
}

/**
 * Bigger working infinity icon for wide terminals. Same pulsing color and
 * travelling highlight as the regular icon, but larger so it reads clearly
 * as the working state from across the room.
 */
export function renderInfinityIconBig(elapsedMs: number): string[] {
  const pulse = nodeColorAt(elapsedMs);
  const glow = new Map(
    infinityGlowForTrack(BIG_ICON_GLOW_TRACK, elapsedMs).map(
      (cell) => [`${cell.row}:${cell.column}`, cell.intensity] as const,
    ),
  );

  return BIG_ICON_CELLS.map((rowCells, row) =>
    rowCells
      .map((bits, column) => {
        if (bits === 0) return " ";
        const intensity = glow.get(`${row}:${column}`) ?? 0;
        const tint = mixColor(pulse, NODE_HIGHLIGHT, intensity);
        return color.bold(rgb(tint.r, tint.g, tint.b)(String.fromCharCode(0x2800 + bits)));
      })
      .join(""),
  );
}
