#!/usr/bin/env node
/**
 * Thin bootstrap. Color configuration must happen before any module that
 * builds ANSI helpers is evaluated, so the real entry point is imported
 * dynamically.
 */
if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
}

const { main } = await import("./main.js");

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`anycode: ${message}\n`);
  const hint =
    error instanceof Error && "hint" in error && typeof error.hint === "string"
      ? error.hint
      : undefined;
  if (hint) process.stderr.write(`hint: ${hint}\n`);
  process.exitCode = 1;
}
