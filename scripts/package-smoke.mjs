#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = path.join(
  workspaceRoot,
  "tests",
  "fixtures",
  "mcp-stdio-server.mjs",
);
const largeFixturePath = path.join(
  workspaceRoot,
  "tests",
  "fixtures",
  "mcp-large-server.mjs",
);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const packages = [
  ["@codemodekit/core", "core"],
  ["@codemodekit/mcp", "mcp"],
  ["@codemodekit/sandbox-quickjs", "sandbox-quickjs"],
  ["codemodekit", "codemodekit"],
  ["@codemodekit/skills", "skills"],
  ["create-codemodekit", "create-codemodekit"],
];

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "codemodekit-package-smoke-"),
);
let client;
let weatherFixture;

try {
  await run(pnpm, ["run", "build"], workspaceRoot);

  const packDirectory = path.join(temporaryRoot, "packs");
  await mkdir(packDirectory, { recursive: true });
  const tarballs = new Map();
  for (const [packageName, directoryName] of packages) {
    const { stdout } = await run(
      pnpm,
      ["pack", "--json", "--pack-destination", packDirectory],
      path.join(workspaceRoot, "packages", directoryName),
    );
    const packed = JSON.parse(stdout);
    if (packed.name !== packageName || typeof packed.filename !== "string") {
      throw new Error(`Unexpected pack result for ${packageName}`);
    }
    await assertPackedPackage(packed.filename, packageName);
    tarballs.set(packageName, packed.filename);
  }

  const createTarball = requiredTarball(tarballs, "create-codemodekit");
  const extractedCreate = path.join(temporaryRoot, "create-package");
  await mkdir(extractedCreate, { recursive: true });
  await run("tar", ["-xzf", createTarball, "-C", extractedCreate], temporaryRoot);
  const extractedSkills = path.join(
    extractedCreate,
    "package",
    "node_modules",
    "@codemodekit",
    "skills",
  );
  await mkdir(extractedSkills, { recursive: true });
  await run(
    "tar",
    [
      "-xzf",
      requiredTarball(tarballs, "@codemodekit/skills"),
      "-C",
      extractedSkills,
      "--strip-components=1",
    ],
    temporaryRoot,
  );
  const standaloneSkillsProject = path.join(temporaryRoot, "skills-only-project");
  await run(
    process.execPath,
    [path.join(extractedSkills, "dist", "cli.js"), standaloneSkillsProject],
    temporaryRoot,
  );
  for (const skill of ["build-codemodekit-server", "author-codemode-skill"]) {
    if (
      !(await lstat(
        path.join(
          standaloneSkillsProject,
          ".agents",
          "skills",
          skill,
          "SKILL.md",
        ),
      )).isFile()
    ) {
      throw new Error(`The packed skills CLI did not install ${skill}`);
    }
  }

  const project = path.join(temporaryRoot, "generated-plugin");
  const upstreamCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)}`;
  const largeUpstreamCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(largeFixturePath)}`;
  await run(
    process.execPath,
    [
      path.join(extractedCreate, "package", "dist", "cli.js"),
      project,
      "--mcp-name",
      "fixture",
      "--mcp-command",
      upstreamCommand,
      "--mcp-name",
      "enterprise",
      "--mcp-command",
      largeUpstreamCommand,
      "--server-name",
      "package-smoke",
      "--agent-plugin",
      "--no-install",
      "--no-sync",
      "--codemodekit-version",
      `file:${requiredTarball(tarballs, "codemodekit")}`,
      "--create-codemodekit-version",
      `file:${createTarball}`,
    ],
    temporaryRoot,
  );
  for (const skill of ["build-codemodekit-server", "author-codemode-skill"]) {
    const skillFile = path.join(
      project,
      ".agents",
      "skills",
      skill,
      "SKILL.md",
    );
    if (!(await lstat(skillFile)).isFile()) {
      throw new Error(`The packed generator did not install ${skill}`);
    }
  }

  await configurePackedProject(project, tarballs, createTarball);

  await run(
    pnpm,
    ["install", "--prefer-offline", "--config.confirmModulesPurge=false"],
    project,
  );
  const liveVerifier = path.join(project, "verify-live.ts");
  await writeFile(
    liveVerifier,
    `const echo = await tools.fixture.echo({ value: "verify-packed" });
const large = await tools.enterprise.zia_url_filtering_list_rule_000({ value: "verify-large" });
return {
  verified:
    echo.structuredContent.value === "verify-packed" &&
    large.structuredContent.value === "verify-large",
};
`,
    "utf8",
  );
  await run(pnpm, ["run", "verify"], project, {
    CODEMODEKIT_VERIFY_CODE_FILE: liveVerifier,
  });
  await run(pnpm, ["run", "plugin:sync"], project);
  const catalogMetadata = JSON.parse(
    await readFile(
      path.join(
        project,
        "skills",
        "use-multi-source-codemode",
        "references",
        "catalog-metadata.json",
      ),
      "utf8",
    ),
  );
  const enterpriseShards = catalogMetadata.declarations.filter(
    (declaration) =>
      declaration.scope === "prefix" && declaration.source === "enterprise",
  );
  if (
    enterpriseShards.length < 7 ||
    enterpriseShards.some((declaration) => declaration.toolCount > 50) ||
    enterpriseShards.reduce(
      (total, declaration) => total + declaration.toolCount,
      0,
    ) !== 306
  ) {
    throw new Error(
      `Unexpected 306-tool catalog shards: ${JSON.stringify(enterpriseShards)}`,
    );
  }
  await run(pnpm, ["run", "plugin:build"], project);

  const artifact = path.join(project, "dist", "plugin");
  const server = path.join(artifact, "server.mjs");
  const wasm = path.join(artifact, "emscripten-module.wasm");
  if (!(await lstat(server)).isFile() || !(await lstat(wasm)).isFile()) {
    throw new Error("The packed packages did not produce a runnable plugin artifact");
  }
  await expectMissing(path.join(artifact, "node_modules"));
  await expectMissing(path.join(artifact, ".env"));

  client = new Client(
    { name: "package-smoke-client", version: "1.0.0" },
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
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    }),
    { timeout: 10_000 },
  );
  const execution = await client.callTool({
    name: "run_typescript",
    arguments: {
      code: `
        const echo = await tools.fixture.echo({ value: "packed" });
        const large = await tools.enterprise.zpa_application_list_065({ value: "large-packed" });
        return {
          echo: echo.structuredContent.value,
          large: large.structuredContent.value,
        };
      `,
    },
  });
  if (
    execution.structuredContent?.ok !== true ||
    execution.structuredContent?.value?.echo !== "packed" ||
    execution.structuredContent?.value?.large !== "large-packed"
  ) {
    throw new Error(
      `Unexpected packed plugin result: ${JSON.stringify(execution.structuredContent)}`,
    );
  }

  await client.close();
  client = undefined;

  weatherFixture = await startWeatherFixture();
  const weatherProject = path.join(temporaryRoot, "generated-weather-plugin");
  await run(
    process.execPath,
    [
      path.join(extractedCreate, "package", "dist", "cli.js"),
      weatherProject,
      "--example",
      "weather",
      "--server-name",
      "weather-package-smoke",
      "--agent-plugin",
      "--no-install",
      "--no-sync",
      "--codemodekit-version",
      `file:${requiredTarball(tarballs, "codemodekit")}`,
      "--create-codemodekit-version",
      `file:${createTarball}`,
    ],
    temporaryRoot,
  );
  await configurePackedProject(weatherProject, tarballs, createTarball);
  await run(
    pnpm,
    ["install", "--prefer-offline", "--config.confirmModulesPurge=false"],
    weatherProject,
  );
  await run(pnpm, ["run", "plugin:sync"], weatherProject);
  await run(pnpm, ["run", "plugin:build"], weatherProject);

  const weatherArtifact = path.join(weatherProject, "dist", "plugin");
  const weatherServer = path.join(weatherArtifact, "server.mjs");
  if (!(await lstat(weatherServer)).isFile()) {
    throw new Error("The weather starter did not produce a runnable plugin artifact");
  }
  const generatedSkill = await readFile(
    path.join(
      weatherArtifact,
      "skills",
      "use-weather-codemode",
      "references",
      "tools.d.ts",
    ),
    "utf8",
  );
  if (
    !generatedSkill.includes("findLocation") ||
    !generatedSkill.includes("getCurrentWeather")
  ) {
    throw new Error("The weather plugin skill is missing its generated tool catalog");
  }

  client = new Client(
    { name: "weather-package-smoke-client", version: "1.0.0" },
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
      args: [weatherServer],
      cwd: temporaryRoot,
      env: {
        PATH: process.env.PATH ?? "",
        OPEN_METEO_GEOCODING_URL: `${weatherFixture.baseUrl}/search`,
        OPEN_METEO_FORECAST_URL: `${weatherFixture.baseUrl}/forecast`,
      },
      stderr: "pipe",
    }),
    { timeout: 10_000 },
  );
  const weatherExecution = await client.callTool({
    name: "run_typescript",
    arguments: {
      code: `
        const location = await tools.weather.findLocation({ query: "Raleigh" });
        const current = await tools.weather.getCurrentWeather({
          latitude: location.structuredContent.latitude,
          longitude: location.structuredContent.longitude,
        });
        return {
          city: location.structuredContent.name,
          temperature: current.structuredContent.temperature,
          condition: current.structuredContent.condition,
        };
      `,
    },
  });
  if (
    weatherExecution.structuredContent?.ok !== true ||
    weatherExecution.structuredContent?.value?.city !== "Raleigh" ||
    weatherExecution.structuredContent?.value?.temperature !== 24.5 ||
    weatherExecution.structuredContent?.value?.condition !== "partly cloudy"
  ) {
    throw new Error(
      `Unexpected packed weather result: ${JSON.stringify(weatherExecution.structuredContent)}`,
    );
  }

  process.stdout.write(
    "Package smoke passed: six tarballs ran portable MCP, 306-tool sharding, generated verification, and Local Tool plugins.\n",
  );
} finally {
  await client?.close().catch(() => undefined);
  await weatherFixture?.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function configurePackedProject(project, tarballs, createTarball) {
  const packageJsonPath = path.join(project, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.dependencies = {
    codemodekit: `file:${requiredTarball(tarballs, "codemodekit")}`,
    "@codemodekit/core": `file:${requiredTarball(tarballs, "@codemodekit/core")}`,
    "@codemodekit/mcp": `file:${requiredTarball(tarballs, "@codemodekit/mcp")}`,
    "@codemodekit/sandbox-quickjs": `file:${requiredTarball(
      tarballs,
      "@codemodekit/sandbox-quickjs",
    )}`,
  };
  packageJson.devDependencies = {
    "create-codemodekit": `file:${createTarball}`,
    "@codemodekit/skills": `file:${requiredTarball(tarballs, "@codemodekit/skills")}`,
    "@modelcontextprotocol/client": "2.0.0-beta.5",
  };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(project, "pnpm-workspace.yaml"),
    [
      "overrides:",
      `  \"@codemodekit/core\": \"file:${requiredTarball(tarballs, "@codemodekit/core")}\"`,
      `  \"@codemodekit/mcp\": \"file:${requiredTarball(tarballs, "@codemodekit/mcp")}\"`,
      `  \"@codemodekit/sandbox-quickjs\": \"file:${requiredTarball(
        tarballs,
        "@codemodekit/sandbox-quickjs",
      )}\"`,
      `  \"@codemodekit/skills\": \"file:${requiredTarball(tarballs, "@codemodekit/skills")}\"`,
      "allowBuilds:",
      "  esbuild: true",
      "",
    ].join("\n"),
    "utf8",
  );
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

async function assertPackedPackage(tarball, expectedName) {
  const { stdout: manifestSource } = await run(
    "tar",
    ["-xOf", tarball, "package/package.json"],
    temporaryRoot,
  );
  const manifest = JSON.parse(manifestSource);
  if (manifest.name !== expectedName) {
    throw new Error(`Packed manifest name mismatch for ${expectedName}`);
  }
  if (manifestSource.includes("workspace:")) {
    throw new Error(`Packed manifest still contains workspace ranges: ${expectedName}`);
  }
  const { stdout: listing } = await run("tar", ["-tf", tarball], temporaryRoot);
  if (!listing.split("\n").includes("package/dist/index.js")) {
    throw new Error(`Packed package is missing dist/index.js: ${expectedName}`);
  }
  if (expectedName === "create-codemodekit") {
    for (const executable of ["cli.js", "plugin-cli.js"]) {
      if (!listing.split("\n").includes(`package/dist/${executable}`)) {
        throw new Error(`Packed generator is missing dist/${executable}`);
      }
    }
  }
  if (expectedName === "@codemodekit/skills") {
    if (manifest.bin?.["codemodekit-skills"] !== "dist/cli.js") {
      throw new Error("Packed skills package is missing its CLI bin mapping");
    }
    if (!listing.split("\n").includes("package/dist/cli.js")) {
      throw new Error("Packed skills package is missing its installer CLI");
    }
    for (const skill of ["build-codemodekit-server", "author-codemode-skill"]) {
      if (!listing.split("\n").includes(`package/skills/${skill}/SKILL.md`)) {
        throw new Error(`Packed skills package is missing ${skill}`);
      }
    }
  }
}

function requiredTarball(tarballs, packageName) {
  const tarball = tarballs.get(packageName);
  if (tarball === undefined) throw new Error(`Missing tarball for ${packageName}`);
  return tarball;
}

async function expectMissing(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Unexpected path in portable artifact: ${file}`);
}

async function run(command, args, cwd, environment = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
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
