import ts from "typescript";

import type {
  CodeCompiler,
  CompileResult,
  ModelDiagnostic,
  SourceLocation,
} from "./contracts.js";

const WRAPPER_PREFIX = "(async () => {\n";
const WRAPPER_SUFFIX = "\n})()";

export class TypeScriptCompiler implements CodeCompiler {
  compile(code: string): CompileResult {
    const wrapped = `${WRAPPER_PREFIX}${code}${WRAPPER_SUFFIX}`;
    const sourceFile = ts.createSourceFile(
      "model.ts",
      wrapped,
      ts.ScriptTarget.ES2023,
      true,
      ts.ScriptKind.TS,
    );

    const unsafe = findUnsafeSyntax(sourceFile);
    if (unsafe !== undefined) {
      return {
        ok: false,
        diagnostic: {
          code: "CODE_UNSAFE_SYNTAX",
          phase: "compile",
          message: unsafe.message,
          location: toModelLocation(sourceFile, unsafe.position),
        },
      };
    }

    const transpiled = ts.transpileModule(wrapped, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        strict: true,
        sourceMap: false,
        removeComments: false,
      },
      fileName: "model.ts",
      reportDiagnostics: true,
    });

    const diagnostic = transpiled.diagnostics?.find(
      (candidate) => candidate.category === ts.DiagnosticCategory.Error,
    );
    if (diagnostic !== undefined) {
      return {
        ok: false,
        diagnostic: compilerDiagnostic(sourceFile, diagnostic),
      };
    }

    return { ok: true, javascript: transpiled.outputText.trim() };
  }
}

interface UnsafeSyntax {
  readonly message: string;
  readonly position: number;
}

function findUnsafeSyntax(sourceFile: ts.SourceFile): UnsafeSyntax | undefined {
  let found: UnsafeSyntax | undefined;

  function visit(node: ts.Node): void {
    if (found !== undefined) {
      return;
    }

    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node)
    ) {
      found = {
        message: "Module imports and exports are not available in Code Mode",
        position: node.getStart(sourceFile),
      };
      return;
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        found = {
          message: "Dynamic import() is not available in Code Mode",
          position: node.expression.getStart(sourceFile),
        };
        return;
      }

      if (
        ts.isIdentifier(node.expression) &&
        ["require", "eval", "Function"].includes(node.expression.text)
      ) {
        found = {
          message: `${node.expression.text}() is not available in Code Mode`,
          position: node.expression.getStart(sourceFile),
        };
        return;
      }
    }

    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Function"
    ) {
      found = {
        message: "Function construction is not available in Code Mode",
        position: node.expression.getStart(sourceFile),
      };
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function compilerDiagnostic(
  sourceFile: ts.SourceFile,
  diagnostic: ts.Diagnostic,
): ModelDiagnostic {
  const location =
    diagnostic.start === undefined
      ? undefined
      : toModelLocation(sourceFile, diagnostic.start);

  return {
    code: "CODE_COMPILE_FAILED",
    phase: "compile",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ...(location === undefined ? {} : { location }),
  };
}

function toModelLocation(
  sourceFile: ts.SourceFile,
  position: number,
): SourceLocation {
  const wrapped = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: Math.max(1, wrapped.line),
    column: wrapped.character + 1,
  };
}
