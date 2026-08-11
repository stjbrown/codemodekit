export interface ParsedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Parses a human-friendly command line without invoking a shell. Quoting and
 * backslash escaping are supported; shell operators and expansion are not.
 */
export function parseMcpCommand(input: string): ParsedCommand {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;
  let escaping = false;

  const finishToken = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) continue;

    if (escaping) {
      token += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (quote === "single") {
      if (character === "'") {
        quote = undefined;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (character === "\"") {
      quote = quote === "double" ? undefined : "double";
      tokenStarted = true;
      continue;
    }

    if (quote === "double") {
      if (character === "`" || (character === "$" && input[index + 1] === "(")) {
        throw unsupportedShellSyntax();
      }
      token += character;
      tokenStarted = true;
      continue;
    }

    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      finishToken();
      continue;
    }

    if ("|&;<>`".includes(character)) {
      throw unsupportedShellSyntax();
    }
    if (character === "$" && input[index + 1] === "(") {
      throw unsupportedShellSyntax();
    }

    token += character;
    tokenStarted = true;
  }

  if (escaping) {
    throw new TypeError("MCP command ends with an incomplete escape");
  }
  if (quote !== undefined) {
    throw new TypeError("MCP command contains an unterminated quote");
  }
  finishToken();

  const command = tokens[0];
  if (command === undefined || command === "") {
    throw new TypeError("MCP command must not be empty");
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(command)) {
    throw new TypeError(
      "Environment assignments are not supported in --mcp-command; configure environment variables outside the command",
    );
  }

  return { command, args: tokens.slice(1) };
}

function unsupportedShellSyntax(): TypeError {
  return new TypeError(
    "Shell operators and expansion are not supported in --mcp-command; pass a single executable and its arguments",
  );
}
