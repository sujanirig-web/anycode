import { clamp } from "./text.js";
import { color } from "./ansi.js";

/** Block-character levels from empty (▁) to full (█). Level N maps to height N. */
const BAR_LEVELS: readonly string[] = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Reference SVG bar heights (left to right), normalized to 1-8 block levels.
 * SVG heights: [10,18,26,34,40,50,16,8,20,40,38,20,12] out of max 50.
 * Normalized: ceil(height/50 * 8):
 *   [2, 3, 5, 6, 7, 8, 3, 2, 4, 7, 7, 4, 2]
 */
const SVG_BASE_HEIGHTS = [2, 3, 5, 6, 7, 8, 3, 2, 4, 7, 7, 4, 2];

export interface WaveformOptions {
  /** Number of vertical bars. Default: 13 (matching the SVG reference). */
  barCount?: number;
  /** Minimum bar height (1-8). Default: 1 */
  minHeight?: number;
  /** Maximum bar height (1-8). Default: 8 */
  maxHeight?: number;
  /** Animation speed multiplier. Default: 1 */
  speed?: number;
  /** Color function applied to each bar. Default: color.gray (#333333 dark gray). */
  color?: (s: string) => string;
  /** Whether the animation is active. Default: false */
  active?: boolean;
  /** When true, renders a static waveform instead of animating. */
  reducedMotion?: boolean;
}

export class Waveform {
  private readonly options: Required<WaveformOptions>;
  private readonly phases: number[];
  private readonly frequencies: number[];
  private startTime: number;

  constructor(options: WaveformOptions = {}) {
    this.options = {
      barCount: options.barCount ?? 13,
      minHeight: options.minHeight ?? 1,
      maxHeight: options.maxHeight ?? 8,
      speed: options.speed ?? 1,
      color: options.color ?? color.white,
      active: options.active ?? false,
      reducedMotion: options.reducedMotion ?? false,
    };

    this.startTime = Date.now();
    // Unique phase and frequency per bar so they bounce independently.
    this.phases = new Array(this.options.barCount).fill(0).map(
      (_, i) => (i / this.options.barCount) * Math.PI * 2,
    );
    this.frequencies = new Array(this.options.barCount).fill(0).map(
      () => 0.6 + Math.random() * 1.4,
    );
  }

  /** Set whether the animation is active. */
  setActive(active: boolean): void {
    this.options.active = active;
    if (active) this.startTime = Date.now();
  }

  /** Set reduced-motion mode. */
  setReducedMotion(reducedMotion: boolean): void {
    this.options.reducedMotion = reducedMotion;
  }

  /** Render the waveform as a centered string of block characters. */
  render(width: number, now: number = Date.now()): string {
    const {
      barCount,
      minHeight,
      maxHeight,
      speed,
      color: colorFn,
      active,
      reducedMotion,
    } = this.options;

    const count = Math.min(barCount, SVG_BASE_HEIGHTS.length);
    const t = ((now - this.startTime) / 1000) * speed;

    const bars: string[] = [];
    for (let i = 0; i < count; i++) {
      const baseHeight = SVG_BASE_HEIGHTS[i] ?? 4;
      let level: number;

      if (!active || reducedMotion) {
        // Static: render at base height.
        level = clamp(baseHeight, minHeight, maxHeight);
      } else {
        // Animated: sine-wave fluctuation around the base height.
        const phase = t * this.frequencies[i]! + this.phases[i]!;
        const wave = Math.sin(phase);
        // Fluctuation range: +/- 2 units around base height.
        const fluctuation = Math.floor((wave + 1) / 2 * 4) - 2; // 0..4 -> -2..2
        level = clamp(baseHeight + fluctuation, minHeight, maxHeight);
      }

      const bar = BAR_LEVELS[Math.min(level - 1, BAR_LEVELS.length - 1)]!;
      bars.push(colorFn(bar));
    }

    return bars.join(" ");
  }
}
