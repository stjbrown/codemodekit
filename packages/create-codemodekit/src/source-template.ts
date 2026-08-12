import type { ParsedCommand } from "./command.js";

export type ScaffoldSource =
  | {
      readonly type: "mcp-stdio";
      readonly name: string;
      readonly command: ParsedCommand;
    }
  | {
      readonly type: "mcp-http";
      readonly name: string;
      readonly url: string;
      /** Reads an Authorization bearer token from this host environment variable. */
      readonly bearerTokenEnv?: string;
      /** Maps HTTP header names to host environment variable names. */
      readonly headerEnv?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "weather";
    };

export interface RenderedSource {
  readonly imports: readonly string[];
  readonly prelude: string;
  readonly expression: string;
}

export interface RenderedSources {
  readonly imports: readonly string[];
  readonly prelude: string;
  readonly expressions: readonly string[];
}

export function renderSources(sources: readonly ScaffoldSource[]): RenderedSources {
  const rendered = sources.map(renderSource);
  const needsEnvironment = sources.some(
    (source) =>
      source.type === "mcp-http" &&
      (source.bearerTokenEnv !== undefined ||
        Object.keys(source.headerEnv ?? {}).length > 0),
  );
  return {
    imports: [...new Set(rendered.flatMap((source) => source.imports))],
    prelude:
      (needsEnvironment ? renderEnvironmentHelper() : "") +
      rendered.map((source) => source.prelude).join(""),
    expressions: rendered.map((source) => source.expression),
  };
}

export function renderSource(source: ScaffoldSource): RenderedSource {
  switch (source.type) {
    case "mcp-stdio":
      return {
        imports: ["mcp"],
        prelude: "",
        expression: `
    mcp.stdio({
      name: ${JSON.stringify(source.name)},
      command: ${JSON.stringify(source.command.command)},
      args: ${JSON.stringify(source.command.args)},
    }),
  `,
      };
    case "mcp-http": {
      const headers = [
        ...(source.bearerTokenEnv === undefined
          ? []
          : [
              `        authorization: "Bearer " + requiredEnvironment(${JSON.stringify(source.bearerTokenEnv)}),`,
            ]),
        ...Object.entries(source.headerEnv ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(
            ([header, environment]) =>
              `        ${JSON.stringify(header)}: requiredEnvironment(${JSON.stringify(environment)}),`,
          ),
      ];
      return {
        imports: ["mcp"],
        prelude: "",
        expression: `
    mcp.http({
      name: ${JSON.stringify(source.name)},
      url: ${JSON.stringify(source.url)},
${headers.length === 0 ? "" : `      headers: {\n${headers.join("\n")}\n      },\n`}
    }),
  `,
      };
    }
    case "weather":
      return {
        imports: ["defineTool", "local", "ToolError"],
        prelude: renderWeatherPrelude(),
        expression: `
    local({
      name: "weather",
      tools: { findLocation, getCurrentWeather },
    }),
  `,
      };
  }
}

export function renderSourcesReadme(sources: readonly ScaffoldSource[]): string {
  if (sources.length === 1) return renderSourceReadme(sources[0] as ScaffoldSource);
  return `It combines ${String(sources.length)} sources in one catalog:\n\n${sources
    .map(
      (source) =>
        `### \`${sourceName(source)}\`\n\n${renderSourceReadme(source)}`,
    )
    .join("\n\n")}`;
}

function renderSourceReadme(source: ScaffoldSource): string {
  switch (source.type) {
    case "mcp-stdio":
      return `It wraps the \`${source.name}\` MCP source using this shell-free process configuration:

\`\`\`json
${JSON.stringify(source.command, null, 2)}
\`\`\``;
    case "mcp-http": {
      const environment = sourceEnvironmentVariables(source);
      const authentication =
        environment.length === 0
          ? ""
          : ` Authentication headers are assembled at runtime from ${environment
              .map((name) => `\`${name}\``)
              .join(", ")}; their values are not written to source or plugin artifacts.`;
      return `It wraps the \`${source.name}\` Streamable HTTP MCP source at \`${source.url}\`.${authentication}`;
    }
    case "weather":
      return `This is the editable, keyless weather starter. It exposes two local tools—\`weather.findLocation\` and \`weather.getCurrentWeather\`—so an agent can compose geocoding and current-weather lookup inside one \`run_typescript\` call.

It uses Open-Meteo's public endpoints by default. The free endpoint is intended for non-commercial use within Open-Meteo's published limits; review their terms before production use. Set \`OPEN_METEO_GEOCODING_URL\` and \`OPEN_METEO_FORECAST_URL\` to use customer or self-hosted endpoints.`;
  }
}

export function renderEnvExample(sources: readonly ScaffoldSource[]): string {
  const sections = sources.map((source) => {
    switch (source.type) {
      case "weather":
        return `# Optional Open-Meteo customer or self-hosted endpoints.
# OPEN_METEO_GEOCODING_URL=https://geocoding-api.open-meteo.com/v1/search
# OPEN_METEO_FORECAST_URL=https://api.open-meteo.com/v1/forecast
`;
      case "mcp-http": {
        const variables = sourceEnvironmentVariables(source);
        return variables.length === 0
          ? `# ${source.name}: add any environment required by the remote MCP source.\n`
          : `# ${source.name}: required HTTP authentication environment.\n${variables
              .map((name) => `${name}=`)
              .join("\n")}\n`;
      }
      case "mcp-stdio":
        return `# ${source.name}: add any environment required by the upstream MCP process.\n`;
    }
  });
  return sections.join("\n");
}

function sourceEnvironmentVariables(
  source: Extract<ScaffoldSource, { readonly type: "mcp-http" }>,
): readonly string[] {
  return [
    ...(source.bearerTokenEnv === undefined ? [] : [source.bearerTokenEnv]),
    ...Object.values(source.headerEnv ?? {}),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function sourceName(source: ScaffoldSource): string {
  return source.type === "weather" ? "weather" : source.name;
}

function renderEnvironmentHelper(): string {
  return `function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Missing required environment variable: " + name);
  }
  return value;
}

`;
}

function renderWeatherPrelude(): string {
  return `const geocodingEndpoint =
  process.env.OPEN_METEO_GEOCODING_URL ??
  "https://geocoding-api.open-meteo.com/v1/search";
const forecastEndpoint =
  process.env.OPEN_METEO_FORECAST_URL ??
  "https://api.open-meteo.com/v1/forecast";

const findLocation = defineTool({
  description: "Find the best matching city and its coordinates",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 2,
        maxLength: 200,
        description: "City, postal code, or city and administrative area",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      country: { type: "string" },
      latitude: { type: "number" },
      longitude: { type: "number" },
      timezone: { type: "string" },
    },
    required: ["name", "country", "latitude", "longitude", "timezone"],
    additionalProperties: false,
  },
  annotations: {
    title: "Find Location",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  execute: async ({ query }, { signal }) => {
    const url = new URL(geocodingEndpoint);
    url.searchParams.set("name", query);
    url.searchParams.set("count", "1");
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");
    const payload = await fetchJson(url, signal, "Location lookup");
    const results = Array.isArray(payload.results) ? payload.results : [];
    const match = asRecord(results[0]);
    if (match === undefined) {
      throw new ToolError("No matching location was found");
    }
    return {
      name: stringField(match, "name", "Location lookup"),
      country: optionalString(match.country),
      latitude: numberField(match, "latitude", "Location lookup"),
      longitude: numberField(match, "longitude", "Location lookup"),
      timezone: optionalString(match.timezone),
    };
  },
});

const getCurrentWeather = defineTool({
  description: "Get current weather for latitude and longitude",
  inputSchema: {
    type: "object",
    properties: {
      latitude: { type: "number", minimum: -90, maximum: 90 },
      longitude: { type: "number", minimum: -180, maximum: 180 },
    },
    required: ["latitude", "longitude"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      time: { type: "string" },
      temperature: { type: "number" },
      apparentTemperature: { type: "number" },
      relativeHumidity: { type: "number" },
      precipitation: { type: "number" },
      weatherCode: { type: "number" },
      condition: { type: "string" },
      windSpeed: { type: "number" },
      units: {
        type: "object",
        properties: {
          temperature: { type: "string" },
          precipitation: { type: "string" },
          windSpeed: { type: "string" },
        },
        required: ["temperature", "precipitation", "windSpeed"],
        additionalProperties: false,
      },
    },
    required: [
      "time",
      "temperature",
      "apparentTemperature",
      "relativeHumidity",
      "precipitation",
      "weatherCode",
      "condition",
      "windSpeed",
      "units",
    ],
    additionalProperties: false,
  },
  annotations: {
    title: "Get Current Weather",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  execute: async ({ latitude, longitude }, { signal }) => {
    const url = new URL(forecastEndpoint);
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set(
      "current",
      "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    );
    url.searchParams.set("timezone", "auto");
    const payload = await fetchJson(url, signal, "Weather lookup");
    const current = requiredRecord(payload.current, "Weather lookup");
    const units = requiredRecord(payload.current_units, "Weather lookup");
    const weatherCode = numberField(current, "weather_code", "Weather lookup");
    return {
      time: stringField(current, "time", "Weather lookup"),
      temperature: numberField(current, "temperature_2m", "Weather lookup"),
      apparentTemperature: numberField(
        current,
        "apparent_temperature",
        "Weather lookup",
      ),
      relativeHumidity: numberField(
        current,
        "relative_humidity_2m",
        "Weather lookup",
      ),
      precipitation: numberField(current, "precipitation", "Weather lookup"),
      weatherCode,
      condition: weatherCondition(weatherCode),
      windSpeed: numberField(current, "wind_speed_10m", "Weather lookup"),
      units: {
        temperature: stringField(units, "temperature_2m", "Weather lookup"),
        precipitation: stringField(units, "precipitation", "Weather lookup"),
        windSpeed: stringField(units, "wind_speed_10m", "Weather lookup"),
      },
    };
  },
});

async function fetchJson(url, signal, label) {
  try {
    const response = await fetch(url, {
      signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new ToolError(label + " returned HTTP " + response.status);
    }
    return requiredRecord(await response.json(), label);
  } catch (error) {
    if (signal.aborted || error instanceof ToolError) throw error;
    throw new ToolError(label + " failed", { cause: error });
  }
}

function requiredRecord(value, label) {
  const record = asRecord(value);
  if (record === undefined) {
    throw new ToolError(label + " returned an unexpected response");
  }
  return record;
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function stringField(record, key, label) {
  const value = record[key];
  if (typeof value !== "string") {
    throw new ToolError(label + " returned an unexpected response");
  }
  return value;
}

function numberField(record, key, label) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolError(label + " returned an unexpected response");
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" ? value : "";
}

function weatherCondition(code) {
  if (code === 0) return "clear sky";
  if (code <= 3) return "partly cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "rain showers";
  if (code <= 86) return "snow showers";
  if (code >= 95) return "thunderstorm";
  return "unknown";
}

`;
}
