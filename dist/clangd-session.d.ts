import { FileLogger } from "./logger.js";
import { type AgentRequest, type SessionConfig } from "./protocol.js";
export interface OperationResult {
    result: unknown;
    truncated?: boolean;
    indexing: boolean;
}
export declare class ClangdSession {
    private readonly config;
    private readonly logger;
    private child;
    private connection;
    private documents;
    private diagnostics;
    private diagnosticWaiters;
    private progressTokens;
    private encoding;
    private stopping;
    private exited;
    private exitPromise;
    private resolveExit;
    constructor(config: SessionConfig, logger: FileLogger);
    get pid(): number | undefined;
    get indexing(): boolean;
    get alive(): boolean;
    start(): Promise<void>;
    execute(request: AgentRequest): Promise<OperationResult>;
    stop(): Promise<void>;
    private installHandlers;
    private ensureDocument;
    private evictDocuments;
    private textPositionParams;
    private locationRequest;
    private hover;
    private documentSymbols;
    private workspaceSymbols;
    private getDiagnostics;
    private normalizeLocation;
    private normalizeSymbol;
    private relativeFile;
    private sendRequest;
}
