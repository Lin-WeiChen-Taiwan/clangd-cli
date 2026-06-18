import type { AgentRequest, SessionConfig } from "./protocol.js";
export declare function discoverWorkspace(request: AgentRequest, cwd?: string): Promise<string>;
export declare function canonicalPath(candidate: string): Promise<string>;
export declare function resolveSessionConfig(request: AgentRequest, cwd?: string): Promise<SessionConfig>;
export declare function sessionId(config: SessionConfig): string;
