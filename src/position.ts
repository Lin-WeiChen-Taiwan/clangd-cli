import { readFile } from "node:fs/promises";
import type { Position, Range } from "vscode-languageserver-protocol";
import type { AgentPosition } from "./protocol.js";
import { CliError } from "./protocol.js";

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

function lineAt(content: string, line: number): string | undefined {
  return content.split(/\r?\n/u)[line];
}

export function toLspPosition(content: string, position: AgentPosition, encoding: PositionEncoding): Position {
  const line = lineAt(content, position.line - 1);
  if (line === undefined) throw new CliError("INVALID_POSITION", `Line ${position.line} is outside the file`, 4);

  const codePoints = Array.from(line);
  if (position.column - 1 > codePoints.length) {
    throw new CliError("INVALID_POSITION", `Column ${position.column} is outside line ${position.line}`, 4);
  }
  const prefix = codePoints.slice(0, position.column - 1).join("");
  const character = encoding === "utf-8" ? Buffer.byteLength(prefix, "utf8") : encoding === "utf-32" ? position.column - 1 : prefix.length;
  return { line: position.line - 1, character };
}

export function fromLspPosition(content: string, position: Position, encoding: PositionEncoding): AgentPosition {
  const line = lineAt(content, position.line) ?? "";
  let prefix: string;
  if (encoding === "utf-8") {
    prefix = Buffer.from(line, "utf8").subarray(0, position.character).toString("utf8");
  } else if (encoding === "utf-32") {
    prefix = Array.from(line).slice(0, position.character).join("");
  } else {
    prefix = line.slice(0, position.character);
  }
  return { line: position.line + 1, column: Array.from(prefix).length + 1 };
}

export async function normalizeRange(file: string, range: Range, encoding: PositionEncoding): Promise<{ start: AgentPosition; end: AgentPosition }> {
  let content = "";
  try {
    content = await readFile(file, "utf8");
  } catch {
    // External declarations may not be readable. Line numbers remain useful.
  }
  return {
    start: fromLspPosition(content, range.start, encoding),
    end: fromLspPosition(content, range.end, encoding),
  };
}
