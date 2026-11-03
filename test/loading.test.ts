/*
┌──────────────────────────────────────────────────────┐
│ test/loading.test.ts — node tracing an infinity loop  │
└──────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INFINITY_COLOR_CYCLE_MS,
  INFINITY_WIDTH,
  nodeColorAt,
  renderInfinityAnimation,
  renderInfinityFrame,
  renderInfinityMark,
} from "../src/ui/infinity.js";
import { stripAnsi } from "../src/util/ansi.js";
import { stringWidth } from "../src/util/width.js";

describe("infinity loading animation", () => {
  it("renders a braille infinity with a visible node", () => {
    const frame = renderInfinityFrame(0);
    assert.equal(frame.length, 2);
    const text = frame.join("\n");
    assert.match(text, /●/);
    assert.match(text, /[\u2801-\u28ff]/);
  });

  it("moves the node around the loop over time", () => {
    const frames = new Set<string>();
    for (let elapsed = 0; elapsed < 2600; elapsed += 200) {
      frames.add(stripAnsi(renderInfinityFrame(elapsed).join("\n")));
    }
    assert.ok(frames.size > 3, "node should occupy several positions");
  });

  it("exposes a compact animation block next to the wider brand mark", () => {
    const animation = renderInfinityAnimation(650);
    assert.equal(animation.lines.length, 2);
    assert.equal(animation.width, 10);
    for (const line of animation.lines) assert.equal(stringWidth(line), animation.width);

    const mark = renderInfinityMark();
    assert.equal(mark.length, 3);
    assert.equal(INFINITY_WIDTH, 15);
    for (const line of mark) assert.equal(stringWidth(line), INFINITY_WIDTH);
  });

  it("shifts the node color slowly from purple to red and back", () => {
    const start = nodeColorAt(0);
    assert.deepEqual(start, { r: 168, g: 85, b: 247 });

    const halfway = nodeColorAt(INFINITY_COLOR_CYCLE_MS / 2);
    assert.deepEqual(halfway, { r: 239, g: 68, b: 68 });
    assert.deepEqual(nodeColorAt(INFINITY_COLOR_CYCLE_MS), start);

    const quarter = nodeColorAt(INFINITY_COLOR_CYCLE_MS / 4);
    assert.ok(quarter.r > start.r, "red should rise over time");
    assert.ok(quarter.b < start.b, "blue should fall over time");
  });

  it("keeps the loop running for any elapsed time", () => {
    for (const elapsed of [1, 1234567, -250]) {
      const frame = renderInfinityFrame(elapsed);
      assert.equal(frame.length, 2);
      assert.match(frame.join("\n"), /●/);
    }
  });
});
