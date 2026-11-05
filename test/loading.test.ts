/*
┌──────────────────────────────────────────────────────┐
│ test/loading.test.ts — brand mark and working pulse   │
└──────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BIG_ICON_WIDTH,
  INFINITY_COLOR_CYCLE_MS,
  INFINITY_ICON_WIDTH,
  INFINITY_SPIN_MS,
  INFINITY_WIDTH,
  infinityGlow,
  nodeColorAt,
  renderInfinityIcon,
  renderInfinityIconBig,
  renderInfinityMark,
} from "../src/ui/infinity.js";
import { stripAnsi } from "../src/util/ansi.js";
import { stringWidth } from "../src/util/width.js";

describe("infinity branding", () => {
  it("renders the 15x3 braille brand mark", () => {
    const mark = renderInfinityMark();
    assert.equal(mark.length, 3);
    assert.equal(INFINITY_WIDTH, 15);
    for (const line of mark) assert.equal(stringWidth(line), INFINITY_WIDTH);

    const text = stripAnsi(mark.join("\n"));
    assert.match(text, /[\u2801-\u28ff]/);
    assert.match(text, /⣏/, "the outer loops should use the full height");
  });

  it("renders a larger 13x3 working icon with a thin waist", () => {
    const icon = renderInfinityIcon(0);
    assert.equal(icon.length, 3);
    assert.equal(INFINITY_ICON_WIDTH, 13);
    for (const line of icon) assert.equal(stringWidth(line), INFINITY_ICON_WIDTH);

    const rows = icon.map(stripAnsi);
    assert.match(rows.join("\n"), /[\u2801-\u28ff]/);
    // A gap above and below the crossing keeps it a figure eight, not glasses.
    assert.ok(rows[0]!.includes(" "), "top row should have a gap between the lobes");
    assert.ok(rows[2]!.includes(" "), "bottom row should have a gap between the lobes");
    assert.match(rows[1]!, /[⠶⣿]/, "middle row should carry the waist");
  });

  it("paints the working icon in the pulse color", () => {
    assert.notEqual(renderInfinityIcon(0).join("\n"), renderInfinityIcon(INFINITY_COLOR_CYCLE_MS / 2).join("\n"));
  });

  it("keeps the working mark braille-only with a soft moving highlight", () => {
    const positions = new Set<string>();
    for (let index = 0; index < 8; index++) {
      const elapsed = (index / 8) * INFINITY_SPIN_MS;
      const icon = renderInfinityIcon(elapsed);
      assert.equal(icon.length, 3);
      for (const line of icon) assert.equal(stringWidth(line), INFINITY_ICON_WIDTH);

      const text = stripAnsi(icon.join("\n"));
      assert.match(text, /[\u2801-\u28ff]/);
      assert.doesNotMatch(text, /●/, "the loader should not draw a bullet over the logo");

      const head = infinityGlow(elapsed)
        .slice()
        .sort((a, b) => b.intensity - a.intensity)[0];
      assert.ok(head, "every frame should have a lit head");
      positions.add(`${head.row}:${head.column}`);
    }
    assert.ok(positions.size >= 4, `the highlight should travel, saw ${positions.size} positions`);

    assert.notEqual(
      renderInfinityIcon(0).join("\n"),
      renderInfinityIcon(INFINITY_SPIN_MS / 2).join("\n"),
      "the highlight should visibly move within one spin",
    );
    assert.equal(
      stripAnsi(renderInfinityIcon(INFINITY_SPIN_MS).join("\n")),
      stripAnsi(renderInfinityIcon(0).join("\n")),
      "the spin should loop back to the first frame",
    );
  });

  it("fades a soft trail behind the highlight", () => {
    const glow = infinityGlow(0);
    assert.ok(glow.length >= 3, "the highlight should cover several cells");
    assert.ok(
      glow.some((cell) => cell.intensity > 0.95),
      "the head should be near full brightness",
    );
    assert.ok(
      glow.some((cell) => cell.intensity > 0.05 && cell.intensity < 0.7),
      "the tail should fade out gradually",
    );
  });

  it("shifts the working infinity color slowly from purple to red and back", () => {
    const start = nodeColorAt(0);
    assert.deepEqual(start, { r: 168, g: 85, b: 247 });

    const halfway = nodeColorAt(INFINITY_COLOR_CYCLE_MS / 2);
    assert.deepEqual(halfway, { r: 239, g: 68, b: 68 });
    assert.deepEqual(nodeColorAt(INFINITY_COLOR_CYCLE_MS), start);

    const quarter = nodeColorAt(INFINITY_COLOR_CYCLE_MS / 4);
    assert.ok(quarter.r > start.r, "red should rise over time");
    assert.ok(quarter.b < start.b, "blue should fall over time");
  });

  it("renders a bigger 21x5 working icon for wide terminals", () => {
    const icon = renderInfinityIconBig(0);
    assert.equal(icon.length, 5);
    assert.equal(BIG_ICON_WIDTH, 21);
    for (const line of icon) assert.equal(stringWidth(line), BIG_ICON_WIDTH);

    const rows = icon.map(stripAnsi);
    assert.match(rows.join("\n"), /[\u2801-\u28ff]/);
  });

  it("animates the bigger icon with a travelling highlight", () => {
    const positions = new Set<string>();
    for (let index = 0; index < 8; index++) {
      const elapsed = (index / 8) * INFINITY_SPIN_MS;
      const icon = renderInfinityIconBig(elapsed);
      assert.equal(icon.length, 5);
      for (const line of icon) assert.equal(stringWidth(line), BIG_ICON_WIDTH);

      const text = stripAnsi(icon.join("\n"));
      assert.match(text, /[\u2801-\u28ff]/);
      assert.doesNotMatch(text, /●/, "the big loader should not draw a bullet over the logo");

      const head = infinityGlow(elapsed)
        .slice()
        .sort((a, b) => b.intensity - a.intensity)[0];
      assert.ok(head, "every frame should have a lit head");
      positions.add(`${head.row}:${head.column}`);
    }
    assert.ok(positions.size >= 4, `the highlight should travel, saw ${positions.size} positions`);

    assert.notEqual(
      renderInfinityIconBig(0).join("\n"),
      renderInfinityIconBig(INFINITY_SPIN_MS / 2).join("\n"),
      "the highlight should visibly move within one spin",
    );
    assert.equal(
      stripAnsi(renderInfinityIconBig(INFINITY_SPIN_MS).join("\n")),
      stripAnsi(renderInfinityIconBig(0).join("\n")),
      "the spin should loop back to the first frame",
    );
  });
});
