import { open, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { ClangdSession } from "./clangd-session.js";
import { ensureSessionDirectory, removeSessionArtifacts, sessionPaths, writeMetadata } from "./ipc.js";
import { FileLogger } from "./logger.js";
import { CliError } from "./protocol.js";
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
export class Daemon {
    config;
    paths;
    logger;
    server = net.createServer((socket) => this.accept(socket));
    session;
    sessionStart;
    idleTimer;
    servedQuery = false;
    shuttingDown = false;
    constructor(config) {
        this.config = config;
        this.paths = sessionPaths(config);
        this.logger = new FileLogger(this.paths.log);
    }
    async run() {
        await ensureSessionDirectory(this.paths);
        if (!(await this.acquireLock()))
            return;
        if (process.platform !== "win32")
            await rm(this.paths.endpoint, { force: true });
        this.server.on("error", (error) => {
            this.logger.error(`IPC server error: ${error.message}`);
            void this.shutdown(1);
        });
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.paths.endpoint, () => {
                this.server.off("error", reject);
                resolve();
            });
        });
        await writeMetadata(this.paths, {
            pid: process.pid,
            endpoint: this.paths.endpoint,
            workspace: this.config.workspace,
            startedAt: new Date().toISOString(),
        });
        this.logger.info(`Daemon listening at ${this.paths.endpoint}`);
        this.resetIdleTimer();
        await new Promise((resolve) => this.server.once("close", resolve));
    }
    accept(socket) {
        this.resetIdleTimer();
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk;
            const newline = buffer.indexOf("\n");
            if (newline < 0)
                return;
            socket.pause();
            let request;
            try {
                request = JSON.parse(buffer.slice(0, newline));
            }
            catch (error) {
                const response = this.errorResponse("status", new CliError("INVALID_IPC_REQUEST", "IPC request is not valid JSON", 2, String(error)), false, Date.now());
                socket.end(`${JSON.stringify(response)}\n`);
                return;
            }
            void this.handle(request).then((response) => {
                socket.end(`${JSON.stringify(response)}\n`);
                if (request.operation === "stop")
                    setTimeout(() => void this.shutdown(0), 25);
            });
        });
        socket.on("error", (error) => this.logger.warn(`IPC client error: ${error.message}`));
    }
    async handle(request) {
        const started = Date.now();
        const reused = this.servedQuery;
        try {
            if (request.operation === "status") {
                return this.successResponse(request.operation, {
                    running: true,
                    daemonPid: process.pid,
                    clangdPid: this.session?.pid ?? null,
                    clangdRunning: this.session?.alive ?? false,
                    indexing: this.session?.indexing ?? false,
                }, reused, started);
            }
            if (request.operation === "stop") {
                return this.successResponse(request.operation, { stopped: true }, reused, started);
            }
            if (request.operation === "restart") {
                await this.session?.stop();
                this.session = undefined;
                const session = await this.ensureSession();
                this.servedQuery = true;
                return this.successResponse(request.operation, { restarted: true, clangdPid: session.pid }, reused, started);
            }
            const result = await this.executeWithRetry(request);
            this.servedQuery = true;
            return {
                version: 1,
                ok: true,
                operation: request.operation,
                result: result.result,
                meta: {
                    workspace: this.config.workspace,
                    durationMs: Date.now() - started,
                    sessionReused: reused,
                    indexing: result.indexing,
                    ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
                },
            };
        }
        catch (error) {
            return this.errorResponse(request.operation, toCliError(error), reused, started);
        }
    }
    async executeWithRetry(request) {
        const timeoutMs = request.timeoutMs ?? 15000;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return await withTimeout((async () => {
                    const session = await this.ensureSession();
                    return session.execute(request);
                })(), timeoutMs);
            }
            catch (error) {
                const retryable = !this.session?.alive || (error instanceof CliError && error.code === "CLANGD_EXITED");
                if (attempt === 0 && retryable) {
                    this.logger.warn("clangd request failed after exit; restarting once");
                    await this.session?.stop();
                    this.session = undefined;
                    continue;
                }
                throw error;
            }
        }
        throw new CliError("CLANGD_EXITED", "clangd exited repeatedly", 3);
    }
    async ensureSession() {
        if (this.session?.alive)
            return this.session;
        if (this.sessionStart)
            return this.sessionStart;
        this.sessionStart = (async () => {
            const session = new ClangdSession(this.config, this.logger);
            await session.start();
            this.session = session;
            return session;
        })();
        try {
            return await this.sessionStart;
        }
        finally {
            this.sessionStart = undefined;
        }
    }
    successResponse(operation, result, reused, started) {
        return {
            version: 1,
            ok: true,
            operation,
            result,
            meta: {
                workspace: this.config.workspace,
                durationMs: Date.now() - started,
                sessionReused: reused,
                indexing: this.session?.indexing ?? false,
            },
        };
    }
    errorResponse(operation, error, reused, started) {
        this.logger.error(`${error.code}: ${error.message}`);
        return {
            version: 1,
            ok: false,
            operation,
            error: {
                code: error.code,
                message: error.message,
                ...(error.details === undefined ? {} : { details: error.details }),
            },
            meta: {
                workspace: this.config.workspace,
                durationMs: Date.now() - started,
                sessionReused: reused,
                indexing: this.session?.indexing ?? false,
            },
        };
    }
    resetIdleTimer() {
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        const idleMs = Number.parseInt(process.env.CLANGD_CLI_IDLE_MS ?? String(DEFAULT_IDLE_MS), 10);
        this.idleTimer = setTimeout(() => {
            this.logger.info("Idle timeout reached");
            void this.shutdown(0);
        }, idleMs);
        this.idleTimer.unref();
    }
    async shutdown(exitCode) {
        if (this.shuttingDown)
            return;
        this.shuttingDown = true;
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        await this.session?.stop();
        await new Promise((resolve) => this.server.close(() => resolve())).catch(() => undefined);
        await removeSessionArtifacts(this.paths);
        process.exitCode = exitCode;
    }
    async acquireLock() {
        try {
            const handle = await open(this.paths.lock, "wx");
            await handle.writeFile(String(process.pid), "utf8");
            await handle.close();
            return true;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const oldPid = Number.parseInt(await readFile(this.paths.lock, "utf8").catch(() => "0"), 10);
            if (oldPid > 0 && isProcessAlive(oldPid))
                return false;
            await rm(this.paths.lock, { force: true });
            const handle = await open(this.paths.lock, "wx");
            await handle.writeFile(String(process.pid), "utf8");
            await handle.close();
            return true;
        }
    }
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function toCliError(error) {
    if (error instanceof CliError)
        return error;
    if (error instanceof Error && error.message === "REQUEST_TIMEOUT") {
        return new CliError("REQUEST_TIMEOUT", "clangd request exceeded timeout", 4);
    }
    return new CliError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), 3);
}
async function withTimeout(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("REQUEST_TIMEOUT")), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=daemon.js.map