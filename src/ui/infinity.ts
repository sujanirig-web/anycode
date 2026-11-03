import { color, rgb } from "../util/ansi.js";

/**
 * Braille infinity loops with a node tracing the path. Two grids share the same
 * curve: the compact 10x2 loader and the wider 15x3 brand mark. The loader is an
 * exact two-thirds scale of the brand, so its proportions never stretch.
 */
const LOADER_WIDTH = 10;
const LOADER_HEIGHT = 2;
const BRAND_WIDTH = 15;
const BRAND_HEIGHT = 3;
const PATH_SAMPLES = 720;
const PERIOD_MS = 2600;
const TRAIL_LENGTH = 2;

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

/** A drawn cell and how far along the loop it sits. */
interface PathCell {
  row: number;
  column: number;
  /** Arc length from the loop start, in dot units. */
  distance: number;
}

/** A braille path plus the ordered loop the node travels along. */
interface InfinityGrid {
  width: number;
  cells: readonly (readonly number[])[];
  /** Cells in traversal order, so the node always sits on the stroke. */
  loop: readonly PathCell[];
  /** Total arc length of the loop in dot units. */
  length: number;
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

/**
 * Precompute the braille path once per grid so each frame only has to move the
 * node. Samples are accumulated into an ordered loop with cumulative arc length;
 * `loopIndexAt` then turns a fraction of the loop into a cell, which keeps the
 * node moving at a steady speed instead of speeding up through the crossing.
 */
function createGrid(width: number, height: number): InfinityGrid {
  const dotWidth = width * 2;
  const dotHeight = height * 4;
  const cells = Array.from({ length: height }, () => Array<number>(width).fill(0));
  const loop: PathCell[] = [];
  let previous: DotPoint | undefined;
  let first: DotPoint | undefined;
  let length = 0;
  let lastKey = "";

  for (let sample = 0; sample < PATH_SAMPLES; sample++) {
    const point = lemniscate((sample / PATH_SAMPLES) * Math.PI * 2, dotWidth, dotHeight);
    const dotX = Math.round(point.x);
    const dotY = Math.round(point.y);
    const cellX = Math.floor(dotX / 2);
    const cellY = Math.floor(dotY / 4);
    const row = cells[cellY];
    if (row && row[cellX] !== undefined) {
      row[cellX]! |= DOT_BITS[dotX % 2]![dotY % 4] ?? 0;
    }

    if (previous) {
      length += Math.hypot(dotX - previous.x, dotY - previous.y);
    } else {
      first = { x: dotX, y: dotY };
    }

    const key = `${cellY}:${cellX}`;
    if (key !== lastKey && row?.[cellX] !== undefined) {
      lastKey = key;
      loop.push({ row: cellY, column: cellX, distance: length });
    }
    previous = { x: dotX, y: dotY };
  }

  // Close the loop so the last cell sits next to the first one.
  if (first && previous) length += Math.hypot(first.x - previous.x, first.y - previous.y);

  const head = loop[0];
  const tail = loop[loop.length - 1];
  if (loop.length > 1 && head && tail && head.row === tail.row && head.column === tail.column) {
    loop.pop();
  }

  return { width, cells, loop, length };
}

const LOADER_GRID = createGrid(LOADER_WIDTH, LOADER_HEIGHT);
const BRAND_GRID = createGrid(BRAND_WIDTH, BRAND_HEIGHT);

/** Index of the loop cell at `fraction` (0..1) of the total arc length. */
function loopIndexAt(grid: InfinityGrid, fraction: number): number {
  const wrapped = ((fraction % 1) + 1) % 1;
  const target = wrapped * grid.length;
  let low = 0;
  let high = grid.loop.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const cell = grid.loop[mid];
    if (cell && cell.distance <= target) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

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
  const index = loopIndexAt(LOADER_GRID, (elapsedMs % PERIOD_MS) / PERIOD_MS);
  const node = LOADER_GRID.loop[index] ?? { row: 0, column: 0, distance: 0 };
  const nodeColor = nodeColorAt(elapsedMs);
  const trail = new Map<string, number>();
  for (let step = 1; step <= TRAIL_LENGTH; step++) {
    const trailIndex = (index - step + LOADER_GRID.loop.length) % LOADER_GRID.loop.length;
    const point = LOADER_GRID.loop[trailIndex];
    if (point) trail.set(`${point.row}:${point.column}`, step);
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
