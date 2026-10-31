#!/usr/bin/env node
/**
 * Thin bootstrap. Color configuration must happen before any module that
 * builds ANSI helpers is evaluated, so the real entry point is imported
 * dynamically.
 */
import { UserError } from "./errors.js";

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
}

const { main } = await import("./main.js");

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UserError) {
    process.stderr.write(`anycode: ${error.message}\n`);
    if (error.hint) {
      process.stderr.write(`hint: ${error.hint}\n`);
    }
    process.exitCode = 1;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`anycode: ${message}\n`);
    if (error instanceof Error && error.stack) {
      process.stderr.write(`Stack trace:\n${error.stack}\n`);
    }
    process.exitCode = 1;
  }
}