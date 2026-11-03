import { color, rgb } from "../util/ansi.js";

/**
 * Braille infinity loops with a node tracing the path. Two grids share the same
 * curve: a compact 8x3 loader that leaves room for the status text beside it,
 * and the wider 15x3 brand mark that balances the ANYCODE wordmark. Both keep
 * the same height so the lobes and the crossing stay readable.
 */
const LOADER_WIDTH = 8;
const LOADER_HEIGHT = 3;
const BRAND_WIDTH = 15;
const BRAND_HEIGHT = 3;
const PATH_SAMPLES = 720;
const PERIOD_MS = 2600;
const TRAIL_LENGTH = 3;
const TRAIL_STEP = 0.16;

/** Time for the node to drift from purple to red and back again. */
export const INFINITY_COLOR_CYCLE_MS = 45_000;

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const NODE_PURPLE: RgbColor = { r: 168, g: 85, b: 247 };
const NODE_RED: RgbColor = { r: 239, g: 68, b: 68 };

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

/** A braille path plus the node mapping for one grid size. */
interface InfinityGrid {
  width: number;
  height: number;
  cells: readonly (readonly number[])[];
  /** Cell occupied by the node at curve parameter `t`. */
  cellFor(t: number): { row: number; column: number };
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

/** Precompute the braille path once per grid so each frame only moves the node. */
function createGrid(width: number, height: number): InfinityGrid {
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
  return {
    width,
    height,
    cells,
    cellFor(t: number) {
      const point = lemniscate(t, dotWidth, dotHeight);
      return {
        row: Math.min(height - 1, Math.max(0, Math.floor(Math.round(point.y) / 4))),
        column: Math.min(width - 1, Math.max(0, Math.floor(Math.round(point.x) / 2))),
      };
    },
  };
}

const LOADER_GRID = createGrid(LOADER_WIDTH, LOADER_HEIGHT);
const BRAND_GRID = createGrid(BRAND_WIDTH, BRAND_HEIGHT);

function mixColor(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount),
  };
}

/**
 * Node color at a point in time. A cosine ease keeps the transition soft at
 * both ends: purple -> red -> purple over {@link INFINITY_COLOR_CYCLE_MS}.
 */
export function nodeColorAt(elapsedMs: number): RgbColor {
  const phase = 0.5 - 0.5 * Math.cos((elapsedMs / INFINITY_COLOR_CYCLE_MS) * Math.PI * 2);
  return mixColor(NODE_PURPLE, NODE_RED, phase);
}

/** Trail dots fade back toward purple behind the node. */
function trailColorAt(elapsedMs: number, index: number): RgbColor {
  const node = nodeColorAt(elapsedMs);
  const amount = 1 - index / (TRAIL_LENGTH + 1);
  return mixColor(NODE_PURPLE, node, amount);
}

/** Render the infinity path with a node tracing it. */
export function renderInfinityFrame(elapsedMs: number): string[] {
  const phase = ((elapsedMs % PERIOD_MS) / PERIOD_MS) * Math.PI * 2;
  const node = LOADER_GRID.cellFor(phase);
  const nodeColor = nodeColorAt(elapsedMs);
  const trail = new Map<string, number>();
  for (let index = 1; index <= TRAIL_LENGTH; index++) {
    const point = LOADER_GRID.cellFor(phase - index * TRAIL_STEP);
    trail.set(`${point.row}:${point.column}`, index);
  }

  return LOADER_GRID.cells.map((rowCells, row) =>
    rowCells
      .map((bits, column) => {
        if (row === node.row && column === node.column) {
          return color.bold(rgb(nodeColor.r, nodeColor.g, nodeColor.b)("●"));
        }
        const trailIndex = trail.get(`${row}:${column}`);
        if (trailIndex !== undefined) {
          const trailColor = trailColorAt(elapsedMs, trailIndex);
          return color.dim(rgb(trailColor.r, trailColor.g, trailColor.b)("•"));
        }
        return bits === 0 ? " " : color.gray(String.fromCharCode(0x2800 + bits));
      })
      .join(""),
  );
}

/** Visible width of the brand mark in terminal columns. */
export const INFINITY_WIDTH = BRAND_GRID.width;

/**
 * Static infinity mark for the empty-session brand. It uses the wider brand
 * path but leaves out the node and trail so it reads as a logo rather than a
 * progress indicator.
 */
export function renderInfinityMark(): string[] {
  return BRAND_GRID.cells.map((rowCells) =>
    color.bold(
      color.magenta(
        rowCells
          .map((bits) => (bits === 0 ? " " : String.fromCharCode(0x2800 + bits)))
          .join(""),
      ),
    ),
  );
}

export interface InfinityAnimation {
  width: number;
  lines: string[];
}

/**
 * Render the infinity block for the status strip. The caller decides where it
 * goes; the lines are not padded to the terminal width.
 */
export function renderInfinityAnimation(elapsedMs: number): InfinityAnimation {
  return { width: LOADER_GRID.width, lines: renderInfinityFrame(elapsedMs) };
}
