import type { AgentRequest, AgentResponse, SessionConfig } from "./protocol.js";
export interface SessionPaths {
    directory: string;
    endpoint: string;
    lock: string;
    metadata: string;
    log: string;
}
export interface SessionMetadata {
    pid: number;
    endpoint: string;
    workspace: string;
    startedAt: string;
}
export declare function runtimeRoot(): string;
export declare function sessionPaths(config: SessionConfig): SessionPaths;
export declare function ensureSessionDirectory(paths: SessionPaths): Promise<void>;
export declare function writeMetadata(paths: SessionPaths, metadata: SessionMetadata): Promise<void>;
export declare function readMetadata(paths: SessionPaths): Promise<SessionMetadata | undefined>;
export declare function removeSessionArtifacts(paths: SessionPaths): Promise<void>;
export declare function sendIpcRequest(endpoint: string, request: AgentRequest, timeoutMs: number): Promise<AgentResponse>;
