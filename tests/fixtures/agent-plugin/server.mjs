import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
if (process.env.PLUGIN_ROOT === undefined || process.env.PLUGIN_DATA === undefined) {
  throw new Error("Agent Plugin reserved environment variables were not provided");
}
if (process.cwd() !== root) {
  throw new Error("Agent Plugin cwd was not resolved to the plugin root");
}
if (
  process.env.EXPECTED_PLUGIN_ROOT !== undefined &&
  process.env.EXPECTED_PLUGIN_ROOT !== process.env.PLUGIN_ROOT
) {
  throw new Error("PLUGIN_ROOT expansion failed");
}
if (
  process.env.EXPECTED_PLUGIN_DATA !== undefined &&
  process.env.EXPECTED_PLUGIN_DATA !== process.env.PLUGIN_DATA
) {
  throw new Error("PLUGIN_DATA expansion failed");
}

await import("../mcp-stdio-server.mjs");
