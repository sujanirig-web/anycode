import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PromptQueue } from "../src/ui/prompt-queue.js";

describe("PromptQueue", () => {
  it("keeps FIFO order when an item is edited or deleted", () => {
    const queue = new PromptQueue();
    queue.enqueue(" first ");
    queue.enqueue("second");
    queue.enqueue("third");

    assert.equal(queue.update(1, "updated second"), true);
    assert.equal(queue.remove(0), "first");
    assert.deepEqual(queue.list(), ["updated second", "third"]);
    assert.equal(queue.takeNext(), "updated second");
    assert.equal(queue.takeNext(), "third");
    assert.equal(queue.takeNext(), undefined);
  });

  it("rejects blank edits and invalid indices", () => {
    const queue = new PromptQueue();
    queue.enqueue("keep me");

    assert.equal(queue.update(0, "   "), false);
    assert.equal(queue.update(1, "out of range"), false);
    assert.equal(queue.remove(-1), undefined);
    assert.deepEqual(queue.list(), ["keep me"]);
  });

  it("updates a queued draft immediately, including while temporarily empty", () => {
    const queue = new PromptQueue();
    queue.enqueue("original prompt");

    assert.equal(queue.setDraft(0, "edited in real time"), true);
    assert.equal(queue.at(0), "edited in real time");
    assert.equal(queue.setDraft(0, ""), true);
    assert.equal(queue.at(0), "");
    assert.equal(queue.update(0, "saved prompt"), true);
    assert.equal(queue.at(0), "saved prompt");
  });
});