import {
  CodeMode,
  TypeScriptCompiler,
  allowAllToolCalls,
} from "@codemodekit/core";
import {
  loadAgentPlugin,
  registerCodeModeTools,
} from "@codemodekit/mcp";
import { QuickJsSandbox } from "@codemodekit/sandbox-quickjs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

async function main(): Promise<void> {
  const pluginRoot = process.argv[2];
  const pluginData = process.argv[3];
  if (pluginRoot === undefined || pluginData === undefined) {
    throw new Error(
      "Usage: agent-plugin-stdio-server <agent-plugin-root> <plugin-data-directory>",
    );
  }

  const plugin = await loadAgentPlugin({
    root: pluginRoot,
    dataDir: pluginData,
    // Deliberately inherit only command lookup. Add ambient state only when
    // the selected plugin explicitly requires and is trusted with it.
    baseEnv:
      process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
  });
  if (plugin.mcp.providers.length === 0) {
    throw new Error("The Agent Plugin did not provide any valid MCP servers");
  }

  const codeMode = new CodeMode({
    compiler: new TypeScriptCompiler(),
    sandbox: new QuickJsSandbox(),
    // This example intentionally authorizes every model-visible plugin tool.
    // Production consumers should replace this with their own policy.
    toolPolicy: allowAllToolCalls(),
    providers: plugin.mcp.providers,
  });

  try {
    const startup = await codeMode.start();
    process.stderr.write(`[code-mode] ${JSON.stringify(startup)}\n`);
    for (const diagnostic of plugin.diagnostics) {
      process.stderr.write(`[agent-plugin] ${JSON.stringify(diagnostic)}\n`);
    }

    const handle = serveStdio(
      () => {
        const server = new McpServer({
          name: "code-mode-agent-plugin",
          version: "0.1.0",
        });
        registerCodeModeTools(server, { codeMode });
        return server;
      },
      {
        onerror: (error) => {
          process.stderr.write(`[downstream-mcp] ${error.message}\n`);
        },
      },
    );

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      shutdownPromise ??= Promise.allSettled([
        handle.close(),
        codeMode.close(),
      ]).then(() => undefined);
      return shutdownPromise;
    };
    const beginShutdown = (): void => {
      void shutdown().catch((error: unknown) => {
        process.stderr.write(`[shutdown] ${safeMessage(error)}\n`);
        process.exitCode = 1;
      });
    };

    process.once("SIGINT", beginShutdown);
    process.once("SIGTERM", beginShutdown);
    process.stdin.once("end", beginShutdown);
  } catch (error) {
    await codeMode.close();
    throw error;
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "Unknown error";
}

void main().catch((error: unknown) => {
  process.stderr.write(`[code-mode] ${safeMessage(error)}\n`);
  process.exitCode = 1;
});
