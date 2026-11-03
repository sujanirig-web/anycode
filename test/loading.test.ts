/*
┌──────────────────────────────────────────────────────┐
│ test/loading.test.ts — brand mark and working pulse   │
└──────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INFINITY_COLOR_CYCLE_MS,
  INFINITY_ICON_WIDTH,
  INFINITY_WIDTH,
  nodeColorAt,
  renderInfinityIcon,
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
});
