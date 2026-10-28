export interface DiffResult {
  /** Unified diff body (without file headers), or an empty string when equal. */
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

interface Op {
  type: " " | "+" | "-";
  text: string;
  oldLine: number;
  newLine: number;
}

const MAX_CELLS = 4_000_000;
const MAX_OUTPUT_LINES = 400;

export function diffLines(before: string, after: string, context = 3): DiffResult {
  if (before === after) return { text: "", added: 0, removed: 0, truncated: false };

  const a = before.split("\n");
  const b = after.split("\n");

  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return {
      text: `@@ file replaced @@\n- ${a.length} lines removed\n+ ${b.length} lines added`,
      added: b.length,
      removed: a.length,
      truncated: true,
    };
  }

  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ type: "-", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
    } else {
      ops.push({ type: "+", text: b[j]!, oldLine: i + 1, newLine: j + 1 });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ type: "-", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
    i++;
  }
  while (j < b.length) {
    ops.push({ type: "+", text: b[j]!, oldLine: i + 1, newLine: j + 1 });
    j++;
  }

  const changed: number[] = [];
  let added = 0;
  let removed = 0;
  ops.forEach((op, index) => {
    if (op.type === "+") {
      added++;
      changed.push(index);
    } else if (op.type === "-") {
      removed++;
      changed.push(index);
    }
  });

  // Merge changed regions separated by less than 2*context equal lines.
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  const out: string[] = [];
  let truncated = false;

  for (const [start, end] of ranges) {
    if (out.length >= MAX_OUTPUT_LINES) {
      truncated = true;
      break;
    }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((op) => op.type !== "+").length;
    const newCount = slice.filter((op) => op.type !== "-").length;
    const oldStart = slice[0]!.oldLine;
    const newStart = slice[0]!.newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      if (out.length >= MAX_OUTPUT_LINES) {
        truncated = true;
        break;
      }
      out.push(`${op.type}${op.text}`);
    }
  }

  if (truncated) out.push("… diff truncated …");

  return { text: out.join("\n"), added, removed, truncated };
}

export function diffStat(added: number, removed: number): string {
  return `+${added} -${removed}`;
}
