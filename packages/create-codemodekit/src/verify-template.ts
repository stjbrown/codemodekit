export function renderVerifyScript(sourceNames: readonly string[]): string {
  return `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = fileURLToPath(new URL("../", import.meta.url));
const client = new Client(
  { name: "codemodekit-generated-verifier", version: "1.0.0" },
  {
    versionNegotiation: {
      mode: "auto",
      probe: { timeoutMs: 5_000, maxRetries: 0 },
    },
    inputRequired: { autoFulfill: false },
  },
);

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/server.mjs", import.meta.url))],
      cwd: root,
      stderr: "pipe",
    }),
    { timeout: 15_000 },
  );

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["run_typescript", "search_tools"],
    "The server must expose exactly the two Code Mode tools",
  );

  for (const source of ${JSON.stringify(sourceNames)}) {
    const search = await client.callTool({
      name: "search_tools",
      arguments: { query: source, source, detail: "summary", limit: 1 },
    });
    assert.notEqual(search.isError, true, "search_tools failed for " + source);
    assert.equal(typeof search.structuredContent?.catalogRevision, "string");
    assert.equal(typeof search.structuredContent?.returned, "number");
  }

  const isolation = await client.callTool({
    name: "run_typescript",
    arguments: {
      code: \`return {
        sum: [1, 2, 3].reduce((total, value) => total + value, 0),
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
      };\`,
    },
  });
  assert.equal(isolation.structuredContent?.ok, true);
  assert.deepEqual(isolation.structuredContent?.value, {
    sum: 6,
    process: "undefined",
    require: "undefined",
    fetch: "undefined",
  });
  assert.deepEqual(isolation.structuredContent?.logs, []);

  await expectToolError(
    () => client.callTool({ name: "run_typescript", arguments: {} }),
    /code|required/i,
  );
  await expectToolError(
    () => client.callTool({ name: "not_a_code_mode_tool", arguments: {} }),
    /tool|not found|unknown/i,
  );

  const liveFile = process.env.CODEMODEKIT_VERIFY_CODE_FILE;
  if (liveFile !== undefined && liveFile.trim() !== "") {
    const code = await readFile(liveFile, "utf8");
    const live = await client.callTool({
      name: "run_typescript",
      arguments: { code },
    });
    assert.equal(live.structuredContent?.ok, true, "Live provider composition failed");
    assert.equal(
      live.structuredContent?.value?.verified,
      true,
      "Live verifier code must return an object containing verified: true",
    );
  }

  process.stdout.write(
    \`Verified Code Mode surface, ${String(sourceNames.length)} source(s), sandbox isolation\${liveFile ? ", and live composition" : ""}.\\n\`,
  );
} finally {
  await client.close();
}

async function expectToolError(call, pattern) {
  let result;
  try {
    result = await call();
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), pattern);
    return;
  }
  assert.equal(result.isError, true, "Expected an MCP tool error result");
  assert.match(JSON.stringify(result), pattern);
}
`;
}
