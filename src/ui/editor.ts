import type { KeyEvent, KeyPress } from "./keys.js";

export type EditResult =
  | { type: "changed" }
  | { type: "submit"; text: string }
  | { type: "unhandled"; key: KeyPress };

const WORD = /[A-Za-z0-9_]/;

function isWord(char: string | undefined): boolean {
  return char !== undefined && WORD.test(char);
}

/** Multi-line composer with history, word movement and kill bindings. */
export class Editor {
  text = "";
  cursor = 0;
  readonly history: string[] = [];
  private index = -1;
  private draft = "";

  get isEmpty(): boolean {
    return this.text.trim().length === 0;
  }

  setText(value: string): void {
    this.text = value;
    this.cursor = value.length;
    this.index = -1;
    this.draft = "";
  }

  clear(): boolean {
    if (this.text.length === 0) return false;
    this.text = "";
    this.cursor = 0;
    this.index = -1;
    this.draft = "";
    return true;
  }

  /** Commit the composer contents to history and reset it. */
  submit(): string | undefined {
    const trimmed = this.text.trim();
    if (trimmed.length === 0) return undefined;

    const entry = this.text.replace(/\s+$/, "");
    if (entry.length > 0 && this.history[this.history.length - 1] !== entry) {
      this.history.push(entry);
      if (this.history.length > 200) this.history.shift();
    }

    const text = entry.trim();
    this.text = "";
    this.cursor = 0;
    this.index = -1;
    this.draft = "";
    return text;
  }

  private insert(value: string): void {
    this.text = this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor);
    this.cursor += value.length;
  }

  private lineStart(at = this.cursor): number {
    return this.text.lastIndexOf("\n", at - 1) + 1;
  }

  private lineEnd(at = this.cursor): number {
    const next = this.text.indexOf("\n", at);
    return next === -1 ? this.text.length : next;
  }

  private wordLeft(at: number): number {
    let index = at;
    while (index > 0 && !isWord(this.text[index - 1])) index--;
    while (index > 0 && isWord(this.text[index - 1])) index--;
    return index;
  }

  private wordRight(at: number): number {
    let index = at;
    while (index < this.text.length && !isWord(this.text[index])) index++;
    while (index < this.text.length && isWord(this.text[index])) index++;
    return index;
  }

  private moveVertical(direction: -1 | 1): boolean {
    const start = this.lineStart();
    const column = this.cursor - start;
    const targetStart = direction === -1 ? this.lineStart(start - 1) : this.lineEnd() + 1;
    if (targetStart < 0 || targetStart > this.text.length) return false;
    if (direction === 1 && this.lineEnd() === this.text.length && start === this.lineStart()) {
      return false;
    }
    const targetEnd = this.lineEnd(targetStart);
    this.cursor = Math.min(targetStart + column, targetEnd);
    return true;
  }

  private recall(direction: -1 | 1): boolean {
    if (this.history.length === 0) return false;

    if (this.index === -1) {
      if (direction === 1) return false;
      this.draft = this.text;
      this.index = this.history.length - 1;
    } else {
      const next = this.index + direction;
      if (next < 0) {
        this.index = 0;
      } else if (next >= this.history.length) {
        this.index = -1;
        this.text = this.draft;
        this.cursor = this.text.length;
        return true;
      } else {
        this.index = next;
      }
    }

    const entry = this.history[this.index];
    if (entry === undefined) return false;
    this.text = entry;
    this.cursor = entry.length;
    return true;
  }

  handle(key: KeyEvent): EditResult {
    if (key.type === "text") {
      if (key.text.length === 0) return { type: "unhandled", key: { type: "key", name: "text" } };
      this.insert(key.text);
      return { type: "changed" };
    }

    const name = key.name;
    const ctrl = key.ctrl === true;

    if (name === "enter") {
      if (key.alt || ctrl || key.shift) {
        this.insert("\n");
        return { type: "changed" };
      }
      const text = this.submit();
      if (text === undefined) return { type: "changed" };
      return { type: "submit", text };
    }

    if (name === "tab") {
      if (key.shift) return { type: "unhandled", key };
      this.insert("  ");
      return { type: "changed" };
    }

    if (name === "backspace") {
      if (this.cursor === 0) return { type: "changed" };
      const from = ctrl ? this.wordLeft(this.cursor) : this.cursor - 1;
      this.text = this.text.slice(0, from) + this.text.slice(this.cursor);
      this.cursor = from;
      return { type: "changed" };
    }

    if (name === "delete") {
      if (this.cursor >= this.text.length) {
        return ctrl ? { type: "unhandled", key } : { type: "changed" };
      }
      const to = ctrl ? this.wordRight(this.cursor) : this.cursor + 1;
      this.text = this.text.slice(0, this.cursor) + this.text.slice(to);
      return { type: "changed" };
    }

    if (name === "left" || name === "right") {
      const direction = name === "left" ? -1 : 1;
      if (ctrl) {
        const target = direction === -1 ? this.wordLeft(this.cursor) : this.wordRight(this.cursor);
        this.cursor = target;
      } else {
        this.cursor = Math.max(0, Math.min(this.text.length, this.cursor + direction));
      }
      return { type: "changed" };
    }

    if (name === "up" || name === "down") {
      const direction = name === "up" ? -1 : 1;
      if (this.text.includes("\n")) {
        return this.moveVertical(direction) ? { type: "changed" } : { type: "unhandled", key };
      }
      return this.recall(direction) ? { type: "changed" } : { type: "unhandled", key };
    }

    if (name === "home" || name === "end") {
      if (ctrl) {
        this.cursor = name === "home" ? 0 : this.text.length;
      } else {
        this.cursor = name === "home" ? this.lineStart() : this.lineEnd();
      }
      return { type: "changed" };
    }

    if (name === "a" && ctrl) {
      this.cursor = this.lineStart();
      return { type: "changed" };
    }
    if (name === "e" && ctrl) {
      this.cursor = this.lineEnd();
      return { type: "changed" };
    }
    if (name === "k" && ctrl) {
      if (this.cursor >= this.text.length) return { type: "changed" };
      this.text = this.text.slice(0, this.cursor);
      return { type: "changed" };
    }
    if (name === "u" && ctrl) {
      if (this.cursor === 0) return { type: "changed" };
      this.text = this.text.slice(this.cursor);
      this.cursor = 0;
      return { type: "changed" };
    }
    if (name === "w" && ctrl) {
      if (this.cursor === 0) return { type: "changed" };
      const from = this.wordLeft(this.cursor);
      this.text = this.text.slice(0, from) + this.text.slice(this.cursor);
      this.cursor = from;
      return { type: "changed" };
    }

    if (name === "escape") {
      if (this.clear()) return { type: "changed" };
      return { type: "unhandled", key };
    }

    return { type: "unhandled", key };
  }
}
