/*
┌──────────────────────────────────────────────────────────────────┐
│ test/websearch.test.ts — keyless DuckDuckGo web search tool        │
└──────────────────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { ToolError } from "../src/errors.js";
import { builtinTools } from "../src/tools/index.js";
import type { ToolContext } from "../src/tools/types.js";
import {
  createWebsearchTool,
  parseDuckDuckGoHtml,
  searchWeb,
} from "../src/tools/websearch.js";

const RESULTS_HTML = `<!DOCTYPE html>
<html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide%3Fa%3D1%26b%3D2&amp;rut=abc">Example &amp; Guide</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">A <b>useful</b> guide &amp; more.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://docs.example.org/intro">Docs</a>
    </h2>
    <div class="result__snippet">Read the <i>documentation</i>&#39;s intro.</div>
  </div>
</div>
</body></html>`;

function context(cwd = process.cwd()): ToolContext {
  return { cwd, approve: async () => true };
}

async function startServer(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/html/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("websearch parsing", () => {
  it("extracts titles, redirected URLs and snippets", () => {
    const results = parseDuckDuckGoHtml(RESULTS_HTML);
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], {
      title: "Example & Guide",
      url: "https://example.com/guide?a=1&b=2",
      snippet: "A useful guide & more.",
    });
    assert.deepEqual(results[1], {
      title: "Docs",
      url: "https://docs.example.org/intro",
      snippet: "Read the documentation's intro.",
    });
  });

  it("returns an empty list for pages without results", () => {
    assert.deepEqual(parseDuckDuckGoHtml("<html><body><p>No results.</p></body></html>"), []);
  });
});

describe("websearch tool", () => {
  it("is registered as a read-only builtin", () => {
    const tool = builtinTools.find((candidate) => candidate.name === "websearch");
    assert.ok(tool, "websearch should be registered in builtinTools");
    assert.equal(tool.readOnly, true);
  });

  it("queries the endpoint and formats results", async () => {
    let receivedURL = "";
    let receivedAgent = "";
    const server = await startServer((request, response) => {
      receivedURL = request.url ?? "";
      receivedAgent = String(request.headers["user-agent"] ?? "");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(RESULTS_HTML);
    });

    try {
      const tool = createWebsearchTool({ endpoint: server.url });
      const output = await tool.execute({ query: "typescript web search" }, context());

      assert.match(output, /Web results for "typescript web search"/);
      assert.match(output, /1\. Example & Guide/);
      assert.match(output, /https:\/\/example\.com\/guide\?a=1&b=2/);
      assert.match(output, /A useful guide & more\./);
      assert.match(output, /2\. Docs/);

      const parsed = new URL(receivedURL, server.url);
      assert.equal(parsed.searchParams.get("q"), "typescript web search");
      assert.match(receivedAgent, /Mozilla\/5\.0/);
    } finally {
      await server.close();
    }
  });

  it("caps results at max_results", async () => {
    const links = Array.from(
      { length: 8 },
      (_, index) =>
        `<a class="result__a" href="https://example.com/${index}">Result ${index}</a>` +
        `<a class="result__snippet">Snippet ${index}</a>`,
    ).join("\n");
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<html><body>${links}</body></html>`);
    });

    try {
      const tool = createWebsearchTool({ endpoint: server.url });
      const output = await tool.execute({ query: "anything", max_results: 3 }, context());
      assert.match(output, /1\. Result 0/);
      assert.match(output, /3\. Result 2/);
      assert.doesNotMatch(output, /Result 3/);
    } finally {
      await server.close();
    }
  });

  it("reports an empty result set with a hint", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body><p>No results.</p></body></html>");
    });

    try {
      const tool = createWebsearchTool({ endpoint: server.url });
      const output = await tool.execute({ query: "unlikely query" }, context());
      assert.match(output, /No web results for "unlikely query"/);
      assert.match(output, /Hint:/);
    } finally {
      await server.close();
    }
  });

  it("rejects blank queries", async () => {
    const tool = createWebsearchTool({ endpoint: "http://127.0.0.1:9/html/" });
    await assert.rejects(tool.execute({}, context()), /required string argument "query"/);
    await assert.rejects(tool.execute({ query: "   " }, context()), /must not be blank/);
  });

  it("surfaces HTTP failures as ToolError with a hint", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("unavailable");
    });

    try {
      const tool = createWebsearchTool({ endpoint: server.url });
      await assert.rejects(tool.execute({ query: "x" }, context()), (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.match(error.message, /HTTP 503/);
        assert.match(String(error.hint), /network|retry/i);
        return true;
      });
    } finally {
      await server.close();
    }
  });

  it("times out stalled requests", async () => {
    const server = await startServer(() => {
      // Never respond.
    });

    try {
      const tool = createWebsearchTool({ endpoint: server.url, timeoutMs: 50 });
      await assert.rejects(tool.execute({ query: "x" }, context()), /timed out after 50ms/);
    } finally {
      await server.close();
    }
  });

  it("honours an aborted signal", async () => {
    await assert.rejects(
      searchWeb("x", { endpoint: "http://127.0.0.1:9/html/", signal: AbortSignal.abort() }),
      /aborted/i,
    );
  });
});
