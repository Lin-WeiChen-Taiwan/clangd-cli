export declare const OPERATIONS: readonly ["definition", "references", "hover", "documentSymbols", "workspaceSymbols", "diagnostics", "status", "stop", "restart"];
export type Operation = (typeof OPERATIONS)[number];
export interface AgentPosition {
    line: number;
    column: number;
}
export interface AgentRequest {
    version: 1;
    operation: Operation;
    workspace?: string;
    compileCommandsDir?: string;
    clangdPath?: string;
    clangdArgs?: string[];
    timeoutMs?: number;
    params?: Record<string, unknown>;
}
export interface SessionConfig {
    workspace: string;
    compileCommandsDir?: string;
    clangdPath: string;
    clangdArgs: string[];
}
export interface ResponseMeta {
    workspace: string;
    durationMs: number;
    sessionReused: boolean;
    indexing?: boolean;
    truncated?: boolean;
}
export interface AgentError {
    code: string;
    message: string;
    details?: unknown;
}
export interface AgentResponse {
    version: 1;
    ok: boolean;
    operation: Operation;
    result?: unknown;
    error?: AgentError;
    meta: ResponseMeta;
}
export declare class CliError extends Error {
    readonly code: string;
    readonly exitCode: number;
    readonly details?: unknown | undefined;
    constructor(code: string, message: string, exitCode?: number, details?: unknown | undefined);
}
export declare function parseRequest(value: unknown): AgentRequest;
export declare function requireParams(request: AgentRequest): Record<string, unknown>;
export declare function requireString(params: Record<string, unknown>, name: string): string;
export declare function requirePosition(params: Record<string, unknown>): AgentPosition;
export declare function optionalLimit(params: Record<string, unknown>, fallback: number): number;
