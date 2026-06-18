import { type SessionConfig } from "./protocol.js";
export declare class Daemon {
    private readonly config;
    private readonly paths;
    private readonly logger;
    private readonly server;
    private session;
    private sessionStart;
    private idleTimer?;
    private servedQuery;
    private shuttingDown;
    constructor(config: SessionConfig);
    run(): Promise<void>;
    private accept;
    private handle;
    private executeWithRetry;
    private ensureSession;
    private successResponse;
    private errorResponse;
    private resetIdleTimer;
    private shutdown;
    private acquireLock;
}
