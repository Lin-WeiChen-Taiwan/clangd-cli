import type { Position, Range } from "vscode-languageserver-protocol";
import type { AgentPosition } from "./protocol.js";
export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";
export declare function toLspPosition(content: string, position: AgentPosition, encoding: PositionEncoding): Position;
export declare function fromLspPosition(content: string, position: Position, encoding: PositionEncoding): AgentPosition;
export declare function normalizeRange(file: string, range: Range, encoding: PositionEncoding): Promise<{
    start: AgentPosition;
    end: AgentPosition;
}>;
