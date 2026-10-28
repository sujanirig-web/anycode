import { stringWidth } from "./width.js";

export interface WrapOptions {
  /** Keep leading whitespace (code blocks) instead of trimming continuations. */
  preserveIndent?: boolean;
}

function sliceToWidth(text: string, width: number): { head: string; rest: string } {
  let head = "";
  let used = 0;
  let index = 0;
  for (const char of text) {
    const next = stringWidth(char);
    if (used + next > width) break;
    head += char;
    used += next;
    index += char.length;
  }
  return { head, rest: text.slice(index) };
}

function lastSpaceIndex(text: string): number {
  for (let index = text.length - 1; index >= 0; index--) {
    if (/\s/.test(text[index] ?? "")) return index;
  }
  return -1;
}

/**
 * Word-wrap `text` to `width` columns. Explicit newlines are hard breaks, long
 * words are split, and indentation is preserved for code when asked.
 */
export function wrapText(text: string, width: number, options: WrapOptions = {}): string[] {
  const limit = Math.max(1, Math.floor(width));
  const out: string[] = [];

  for (const logical of text.split(/\r?\n/)) {
    if (logical.length === 0) {
      out.push("");
      continue;
    }
    if (stringWidth(logical) <= limit) {
      out.push(logical);
      continue;
    }

    const indent = options.preserveIndent ? (/^[ \t]*/.exec(logical)?.[0] ?? "") : "";
    let remaining = logical;
    let first = true;

    while (remaining.length > 0) {
      if (stringWidth(remaining) <= limit) {
        out.push(remaining);
        break;
      }

      const { head, rest } = sliceToWidth(remaining, limit);
      if (rest.length === 0) {
        out.push(head);
        break;
      }

      const space = lastSpaceIndex(head);
      if (space > 0) {
        const cut = head.slice(0, space).replace(/\s+$/, "");
        out.push(cut.length > 0 ? cut : head);
        const consumed = remaining.slice(0, space + 1);
        remaining = remaining.slice(consumed.length);
      } else {
        out.push(head);
        remaining = rest;
      }

      if (!first || !options.preserveIndent) {
        remaining = remaining.replace(/^[ \t]+/, options.preserveIndent ? indent : "");
      }
      first = false;
    }
  }

  return out;
}
