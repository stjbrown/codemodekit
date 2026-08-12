#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "codemodekit-registry-canary-"),
);
const project = path.join(temporaryRoot, "weather-code-mode");
let client;
let fixture;

try {
  await run(
    "npm",
    [
      "create",
      "codemodekit@latest",
      project,
      "--",
      "--example",
      "weather",
      "--server-name",
      "registry-weather-canary",
      "--agent-plugin",
      "--no-authoring-skill",
    ],
    temporaryRoot,
  );

  const artifact = path.join(project, "dist", "plugin");
  const server = path.join(artifact, "server.mjs");
  const wasm = path.join(artifact, "emscripten-module.wasm");
  if (!(await lstat(server)).isFile() || !(await lstat(wasm)).isFile()) {
    throw new Error("The registry generator did not build a portable plugin");
  }
  const skill = await readFile(
    path.join(
      artifact,
      "skills",
      "use-weather-codemode",
      "references",
      "tools.d.ts",
    ),
    "utf8",
  );
  if (!skill.includes("findLocation") || !skill.includes("getCurrentWeather")) {
    throw new Error("The registry plugin is missing its weather tool reference");
  }

  fixture = await startWeatherFixture();
  client = new Client(
    { name: "registry-canary-client", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: "auto",
        probe: { timeoutMs: 5_000, maxRetries: 0 },
      },
      inputRequired: { autoFulfill: false },
    },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      cwd: temporaryRoot,
      env: {
        PATH: process.env.PATH ?? "",
        OPEN_METEO_GEOCODING_URL: `${fixture.baseUrl}/search`,
        OPEN_METEO_FORECAST_URL: `${fixture.baseUrl}/forecast`,
      },
      stderr: "pipe",
    }),
    { timeout: 10_000 },
  );

  const result = await client.callTool({
    name: "run_typescript",
    arguments: {
      code: `
        const location = await tools.weather.findLocation({ query: "Raleigh" });
        const weather = await tools.weather.getCurrentWeather({
          latitude: location.structuredContent.latitude,
          longitude: location.structuredContent.longitude,
        });
        return location.structuredContent.name + ": " +
          weather.structuredContent.temperature +
          weather.structuredContent.units.temperature;
      `,
    },
  });
  if (
    result.structuredContent?.ok !== true ||
    result.structuredContent?.value !== "Raleigh: 24.5°C"
  ) {
    throw new Error(
      `Unexpected registry canary result: ${JSON.stringify(result.structuredContent)}`,
    );
  }

  process.stdout.write(
    "Registry canary passed: npm create built and ran the weather Agent Plugin.\n",
  );
} finally {
  await client?.close().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function startWeatherFixture() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/search")) {
      response.end(
        JSON.stringify({
          results: [
            {
              name: "Raleigh",
              country: "United States",
              latitude: 35.7796,
              longitude: -78.6382,
              timezone: "America/New_York",
            },
          ],
        }),
      );
      return;
    }
    if (request.url?.startsWith("/forecast")) {
      response.end(
        JSON.stringify({
          current: {
            time: "2026-08-12T12:00",
            temperature_2m: 24.5,
            apparent_temperature: 25.1,
            relative_humidity_2m: 70,
            precipitation: 0,
            weather_code: 1,
            wind_speed_10m: 8.2,
          },
          current_units: {
            temperature_2m: "°C",
            precipitation: "mm",
            wind_speed_10m: "km/h",
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Weather fixture did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
  };
}

async function run(command, args, cwd) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180_000,
      env: { ...process.env, npm_config_yes: "true" },
    });
  } catch (error) {
    if (error && typeof error === "object") {
      const stdout = "stdout" in error ? String(error.stdout ?? "") : "";
      const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
      error.message = `${error.message}\n${stdout}${stderr}`.trim();
    }
    throw error;
  }
}
