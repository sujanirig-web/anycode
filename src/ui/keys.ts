export interface KeyPress {
  type: "key";
  /** "enter", "escape", "left", "a", … */
  name: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface MouseEvent {
  type: "mouse";
  /** Mouse button: 0 = left, 1 = middle, 2 = right, 64/65 = wheel. */
  button: number;
  /** Column index (1-based). */
  x: number;
  /** Row index (1-based). */
  y: number;
  /** true when the button was released (`m` terminator). */
  release: boolean;
}

export interface TextInput {
  type: "text";
  text: string;
}

export type KeyEvent = KeyPress | MouseEvent | TextInput;

const PRINTABLE = /^[A-Za-z0-9]$/;
// Non-global regexes are safe to reuse across calls; hoisting avoids allocating
// a new matcher on every parser iteration.
const MOUSE_SEQUENCE = /^\u001b\[<([0-9]*);([0-9]*);([0-9]*)([Mm])/;
const CSI_SEQUENCE = /^\u001b\[([0-9;?]*)([@-~])/;
const SS3_SEQUENCE = /^\u001bO([A-Za-z])/;

function controlLetter(code: number): string | undefined {
  if (code < 1 || code > 26) return undefined;
  return String.fromCharCode(96 + code);
}

function pushPlain(chunk: string, events: KeyEvent[]): void {
  let text = "";
  const flush = (): void => {
    if (text.length > 0) {
      events.push({ type: "text", text });
      text = "";
    }
  };

  for (const char of chunk) {
    const code = char.codePointAt(0) ?? 0;

    if (char === "\r") {
      flush();
      events.push({ type: "key", name: "enter" });
      continue;
    }
    if (char === "\n") {
      flush();
      events.push({ type: "key", name: "enter", ctrl: true });
      continue;
    }
    if (char === "\t") {
      flush();
      events.push({ type: "key", name: "tab" });
      continue;
    }
    if (char === "\u007f" || char === "\b") {
      flush();
      events.push({ type: "key", name: "backspace" });
      continue;
    }

    const letter = controlLetter(code);
    if (letter) {
      flush();
      events.push({ type: "key", name: letter, ctrl: true });
      continue;
    }

    if (code < 32) continue;
    text += char;
  }

  flush();
}

function csiEvent(params: string, final: string): KeyEvent | undefined {
  const parts = params.split(";");
  const mod = parts.length > 1 ? Number.parseInt(parts[1] ?? "", 10) : 1;
  const bits = Number.isFinite(mod) && mod > 0 ? mod - 1 : 0;
  const ctrl = (bits & 4) !== 0;
  const alt = (bits & 2) !== 0;
  const shift = (bits & 1) !== 0;
  const first = parts[0] ?? "";
  const number = Number.parseInt(first, 10);

  const modifier = {
    ...(ctrl ? { ctrl: true } : {}),
    ...(alt ? { alt: true } : {}),
    ...(shift ? { shift: true } : {}),
  };

  switch (final) {
    case "A":
      return { type: "key", name: "up", ...modifier };
    case "B":
      return { type: "key", name: "down", ...modifier };
    case "C":
      return { type: "key", name: "right", ...modifier };
    case "D":
      return { type: "key", name: "left", ...modifier };
    case "H":
      return { type: "key", name: "home", ...modifier };
    case "F":
      return { type: "key", name: "end", ...modifier };
    case "Z":
      return { type: "key", name: "tab", shift: true };
    case "~": {
      if (number === 1 || number === 7) return { type: "key", name: "home", ...modifier };
      if (number === 4 || number === 8) return { type: "key", name: "end", ...modifier };
      if (number === 3) return { type: "key", name: "delete", ...modifier };
      if (number === 5) return { type: "key", name: "pageup", ...modifier };
      if (number === 6) return { type: "key", name: "pagedown", ...modifier };
      if (number === 2) return { type: "key", name: "insert", ...modifier };
      return undefined;
    }
    case "u": {
      const codepoint = Number.parseInt(parts.slice(-1)[0] ?? "", 10);
      if (!Number.isFinite(codepoint)) return undefined;
      if (codepoint === 13) return { type: "key", name: "enter", ...modifier };
      if (codepoint === 27) return { type: "key", name: "escape", ...modifier };
      if (codepoint === 9) return { type: "key", name: "tab", ...modifier };
      return { type: "text", text: String.fromCodePoint(codepoint) };
    }
    default:
      return undefined;
  }
}

/**
 * Incremental parser for raw terminal input: escape sequences, control keys and
 * bracketed paste. Chunks may split sequences, so incomplete input is buffered
 * until more bytes arrive (or `flush()` is called for a lone Escape key).
 */
export class KeyParser {
  private pending = "";

  get pendingLength(): number {
    return this.pending.length;
  }

  push(chunk: string): KeyEvent[] {
    this.pending += chunk;
    return this.drain(false);
  }

  flush(): KeyEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): KeyEvent[] {
    const events: KeyEvent[] = [];
    let buffer = this.pending;

    while (buffer.length > 0) {
      if (!buffer.startsWith("\u001b")) {
        const next = buffer.indexOf("\u001b");
        const plain = next === -1 ? buffer : buffer.slice(0, next);
        buffer = next === -1 ? "" : buffer.slice(next);
        pushPlain(plain, events);
        continue;
      }

      if (buffer.length === 1) {
        if (final) {
          events.push({ type: "key", name: "escape" });
          buffer = "";
        }
        break;
      }

      if (buffer.startsWith("\u001b[200~")) {
        const end = buffer.indexOf("\u001b[201~");
        if (end === -1) {
          if (!final) break;
          const pasted = buffer.slice(6);
          buffer = "";
          if (pasted.length > 0) {
            events.push({ type: "text", text: pasted.replace(/\r\n?/g, "\n") });
          }
          continue;
        }
        const pasted = buffer.slice(6, end);
        buffer = buffer.slice(end + 6);
        if (pasted.length > 0) {
          events.push({ type: "text", text: pasted.replace(/\r\n?/g, "\n") });
        }
        continue;
      }

      // Classic X10 mouse protocol: \e[M followed by three raw bytes
      // (button + 32, x + 32, y + 32). Some terminals ignore SGR mode, so
      // parse this fallback before the generic CSI handling below, which
      // would otherwise swallow the payload as an unknown sequence.
      if (buffer.startsWith("\u001b[M")) {
        if (buffer.length < 6) {
          if (!final) break;
          events.push({ type: "key", name: "escape" });
          buffer = buffer.slice(1);
          continue;
        }
        const code = (buffer.charCodeAt(3) ?? 0) - 32;
        const x = (buffer.charCodeAt(4) ?? 0) - 32;
        const y = (buffer.charCodeAt(5) ?? 0) - 32;
        buffer = buffer.slice(6);
        // Bit 6 marks wheel events (64/65); bit 5 marks motion. Both must not
        // be mistaken for a left-button press.
        const wheel = (code & 64) !== 0;
        const motion = (code & 32) !== 0;
        const button = wheel ? 64 + (code & 1) : code & 3;
        events.push({ type: "mouse", button, x, y, release: !wheel && !motion && button === 3 });
        continue;
      }

      if (buffer[1] === "[") {
        // Mouse protocol (SGR mode ?1006h): \e[<{button};{x};{y}[Mm]
        // Capture button, x, y and release flag so the TUI can hit-test.
        const mouseMatch = MOUSE_SEQUENCE.exec(buffer);
        if (mouseMatch) {
          buffer = buffer.slice(mouseMatch[0].length);
          const button = Number(mouseMatch[1] ?? "0") || 0;
          const x = Number(mouseMatch[2] ?? "1") || 1;
          const y = Number(mouseMatch[3] ?? "1") || 1;
          const release = mouseMatch[4] === "m";
          events.push({ type: "mouse", button, x, y, release });
          continue;
        }
        const match = CSI_SEQUENCE.exec(buffer);
        if (!match) {
          if (!final) break;
          events.push({ type: "key", name: "escape" });
          buffer = buffer.slice(1);
          continue;
        }
        buffer = buffer.slice(match[0].length);
        const event = csiEvent(match[1] ?? "", match[2] ?? "");
        if (event) events.push(event);
        continue;
      }

      if (buffer[1] === "O") {
        const match = SS3_SEQUENCE.exec(buffer);
        if (!match) {
          if (!final) break;
          events.push({ type: "key", name: "escape" });
          buffer = buffer.slice(1);
          continue;
        }
        buffer = buffer.slice(match[0].length);
        const letter = match[1] ?? "";
        if (PRINTABLE.test(letter)) {
          events.push({ type: "key", name: letter.toLowerCase(), alt: true });
        }
        continue;
      }

      const char = buffer[1] ?? "";
      buffer = buffer.slice(2);
      if (char === "\r" || char === "\n") {
        events.push({ type: "key", name: "enter", alt: true });
      } else if (PRINTABLE.test(char)) {
        events.push({ type: "key", name: char.toLowerCase(), alt: true });
      } else {
        events.push({ type: "text", text: char });
      }
    }

    this.pending = buffer;
    return events;
  }
}
