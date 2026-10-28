export interface SSEMessage {
  event?: string;
  data: string;
}

function parseBlock(block: string): SSEMessage | null {
  const lines = block.split(/\r?\n/);
  const data: string[] = [];
  let event: string | undefined;
  let hasField = false;

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") {
      data.push(value);
      hasField = true;
    } else if (field === "event") {
      event = value;
      hasField = true;
    }
  }

  if (!hasField) return null;
  const message: SSEMessage = { data: data.join("\n") };
  if (event !== undefined) message.event = event;
  return message;
}

/** Incremental Server-Sent Events parser over a web ReadableStream. */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const message = parseBlock(raw);
        if (message) yield message;
      }
    }

    buffer += decoder.decode();
    const rest = parseBlock(buffer);
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}
