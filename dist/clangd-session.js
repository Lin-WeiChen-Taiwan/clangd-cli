import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMessageConnection } from "vscode-jsonrpc/node";
import { normalizeRange, toLspPosition } from "./position.js";
import { CliError, optionalLimit, requireParams, requirePosition, requireString } from "./protocol.js";
export class ClangdSession {
    config;
    logger;
    child;
    connection;
    documents = new Map();
    diagnostics = new Map();
    diagnosticWaiters = new Map();
    progressTokens = new Set();
    encoding = "utf-16";
    stopping = false;
    exited = false;
    exitPromise = Promise.resolve();
    resolveExit;
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    get pid() {
        return this.child?.pid;
    }
    get indexing() {
        return this.progressTokens.size > 0;
    }
    get alive() {
        return Boolean(this.child && !this.exited);
    }
    async start() {
        if (this.alive)
            return;
        this.stopping = false;
        this.exited = false;
        this.exitPromise = new Promise((resolve) => {
            this.resolveExit = resolve;
        });
        const args = [...this.config.clangdArgs];
        if (!args.some((argument) => argument.startsWith("--background-index")))
            args.push("--background-index");
        if (this.config.compileCommandsDir)
            args.push(`--compile-commands-dir=${this.config.compileCommandsDir}`);
        this.logger.info(`Starting ${this.config.clangdPath} ${args.join(" ")}`);
        const child = spawn(this.config.clangdPath, args, {
            cwd: this.config.workspace,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        this.child = child;
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => this.logger.log(`[clangd] ${chunk.trimEnd()}`));
        child.on("exit", (code, signal) => {
            this.exited = true;
            this.resolveExit?.();
            this.logger.warn(`clangd exited code=${String(code)} signal=${String(signal)}`);
        });
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(new CliError("CLANGD_NOT_FOUND", `Failed to start clangd: ${error.message}`, 3));
            child.once("error", onError);
            child.once("spawn", () => {
                child.off("error", onError);
                resolve();
            });
        });
        const connection = createMessageConnection(child.stdout, child.stdin, this.logger);
        this.connection = connection;
        this.installHandlers(connection);
        connection.listen();
        const rootUri = pathToFileURL(this.config.workspace).href;
        const initialized = (await this.sendRequest("initialize", {
            processId: process.pid,
            clientInfo: { name: "clangd-cli", version: "0.1.0" },
            rootUri,
            workspaceFolders: [{ uri: rootUri, name: path.basename(this.config.workspace) }],
            capabilities: {
                general: { positionEncodings: ["utf-8", "utf-16", "utf-32"] },
                workspace: { symbol: {}, workspaceFolders: true },
                textDocument: {
                    hover: {},
                    definition: {},
                    references: {},
                    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    publishDiagnostics: { versionSupport: true },
                },
                window: { workDoneProgress: true },
            },
        }));
        this.encoding = initialized.capabilities?.positionEncoding ?? "utf-16";
        await connection.sendNotification("initialized", {});
        this.logger.info(`clangd initialized with ${this.encoding} positions`);
    }
    async execute(request) {
        if (!this.connection || !this.alive)
            throw new CliError("CLANGD_EXITED", "clangd is not running", 3);
        const params = requireParams(request);
        switch (request.operation) {
            case "definition":
                return this.locationRequest("textDocument/definition", params, 2000);
            case "references":
                return this.locationRequest("textDocument/references", params, optionalLimit(params, 200), { includeDeclaration: true });
            case "hover":
                return this.hover(params);
            case "documentSymbols":
                return this.documentSymbols(params);
            case "workspaceSymbols":
                return this.workspaceSymbols(params);
            case "diagnostics":
                return this.getDiagnostics(params);
            default:
                throw new CliError("UNSUPPORTED_OPERATION", `Operation ${request.operation} is not a clangd query`, 2);
        }
    }
    async stop() {
        if (!this.child)
            return;
        this.stopping = true;
        try {
            if (this.connection && !this.exited) {
                await Promise.race([
                    this.connection.sendRequest("shutdown", null),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), 2000)),
                ]);
                await this.connection.sendNotification("exit");
            }
        }
        catch {
            // Force termination below.
        }
        if (!this.exited)
            this.child.kill();
        this.connection?.dispose();
        this.connection = undefined;
        this.child = undefined;
        this.documents.clear();
        this.diagnostics.clear();
    }
    installHandlers(connection) {
        connection.onRequest((method, params) => {
            if (method === "workspace/configuration") {
                const items = params?.items ?? [];
                return items.map(() => null);
            }
            if (method === "workspace/applyEdit")
                return { applied: false, failureReason: "clangd-cli is read-only" };
            return null;
        });
        connection.onNotification("textDocument/publishDiagnostics", (params) => {
            const state = {
                diagnostics: params.diagnostics,
                ...(params.version === undefined ? {} : { version: params.version }),
            };
            this.diagnostics.set(params.uri, state);
            for (const resolve of this.diagnosticWaiters.get(params.uri) ?? [])
                resolve(state);
            this.diagnosticWaiters.delete(params.uri);
        });
        connection.onNotification("$/progress", (params) => {
            if (params.value?.kind === "begin")
                this.progressTokens.add(params.token);
            if (params.value?.kind === "end")
                this.progressTokens.delete(params.token);
        });
        connection.onUnhandledNotification((message) => this.logger.log(`Unhandled notification ${message.method}`));
    }
    async ensureDocument(fileValue) {
        const file = path.resolve(this.config.workspace, fileValue);
        let content;
        try {
            content = await readFile(file, "utf8");
        }
        catch (error) {
            throw new CliError("FILE_NOT_FOUND", `Cannot read source file: ${file}`, 4, String(error));
        }
        const uri = pathToFileURL(file).href;
        const existing = this.documents.get(file);
        if (!existing) {
            this.documents.set(file, { content, version: 1, touched: Date.now() });
            this.diagnostics.delete(uri);
            await this.connection.sendNotification("textDocument/didOpen", {
                textDocument: { uri, languageId: languageId(file), version: 1, text: content },
            });
        }
        else if (existing.content !== content) {
            existing.content = content;
            existing.version += 1;
            existing.touched = Date.now();
            this.diagnostics.delete(uri);
            await this.connection.sendNotification("textDocument/didChange", {
                textDocument: { uri, version: existing.version },
                contentChanges: [{ text: content }],
            });
        }
        else {
            existing.touched = Date.now();
        }
        await this.evictDocuments();
        return { file, uri, content };
    }
    async evictDocuments() {
        if (this.documents.size <= 32)
            return;
        const entries = [...this.documents.entries()].sort((a, b) => a[1].touched - b[1].touched);
        for (const [file] of entries.slice(0, this.documents.size - 32)) {
            this.documents.delete(file);
            await this.connection.sendNotification("textDocument/didClose", { textDocument: { uri: pathToFileURL(file).href } });
        }
    }
    async textPositionParams(params) {
        const document = await this.ensureDocument(requireString(params, "file"));
        return { document, position: toLspPosition(document.content, requirePosition(params), this.encoding) };
    }
    async locationRequest(method, params, limit, context) {
        const { document, position } = await this.textPositionParams(params);
        const response = await this.sendRequest(method, {
            textDocument: { uri: document.uri },
            position,
            ...(context ? { context } : {}),
        });
        const values = response === null ? [] : Array.isArray(response) ? response : [response];
        const sliced = values.slice(0, limit);
        return {
            result: { locations: await Promise.all(sliced.map((location) => this.normalizeLocation(location))) },
            truncated: values.length > limit,
            indexing: this.indexing,
        };
    }
    async hover(params) {
        const { document, position } = await this.textPositionParams(params);
        const response = (await this.sendRequest("textDocument/hover", {
            textDocument: { uri: document.uri },
            position,
        }));
        if (!response)
            return { result: null, indexing: this.indexing };
        return {
            result: {
                contents: response.contents,
                ...(response.range ? { range: await normalizeRange(document.file, response.range, this.encoding) } : {}),
            },
            indexing: this.indexing,
        };
    }
    async documentSymbols(params) {
        const document = await this.ensureDocument(requireString(params, "file"));
        const response = (await this.sendRequest("textDocument/documentSymbol", {
            textDocument: { uri: document.uri },
        }));
        const symbols = await Promise.all((response ?? []).map((symbol) => this.normalizeSymbol(symbol, document.file)));
        return { result: { symbols }, indexing: this.indexing };
    }
    async workspaceSymbols(params) {
        const query = requireString(params, "query");
        const limit = optionalLimit(params, 100);
        const response = (await this.sendRequest("workspace/symbol", { query }));
        const values = response ?? [];
        return {
            result: { symbols: await Promise.all(values.slice(0, limit).map((symbol) => this.normalizeSymbol(symbol))) },
            truncated: values.length > limit,
            indexing: this.indexing,
        };
    }
    async getDiagnostics(params) {
        const document = await this.ensureDocument(requireString(params, "file"));
        const state = this.diagnostics.get(document.uri) ?? (await new Promise((resolve) => {
            const waiters = this.diagnosticWaiters.get(document.uri) ?? [];
            waiters.push(resolve);
            this.diagnosticWaiters.set(document.uri, waiters);
        }));
        return {
            result: {
                diagnostics: await Promise.all(state.diagnostics.map(async (diagnostic) => ({
                    range: await normalizeRange(document.file, diagnostic.range, this.encoding),
                    severity: diagnostic.severity,
                    code: diagnostic.code,
                    source: diagnostic.source,
                    message: diagnostic.message,
                }))),
            },
            indexing: this.indexing,
        };
    }
    async normalizeLocation(value) {
        const uri = "uri" in value ? value.uri : value.targetUri;
        const range = "range" in value ? value.range : value.targetSelectionRange;
        const file = fileURLToPath(uri);
        return { file: this.relativeFile(file), range: await normalizeRange(file, range, this.encoding) };
    }
    async normalizeSymbol(symbol, defaultFile) {
        if ("location" in symbol) {
            const file = fileURLToPath(symbol.location.uri);
            return {
                name: symbol.name,
                kind: symbol.kind,
                containerName: symbol.containerName,
                file: this.relativeFile(file),
                range: await normalizeRange(file, symbol.location.range, this.encoding),
            };
        }
        const file = defaultFile ?? this.config.workspace;
        return {
            name: symbol.name,
            kind: symbol.kind,
            detail: symbol.detail,
            range: await normalizeRange(file, symbol.range, this.encoding),
            selectionRange: await normalizeRange(file, symbol.selectionRange, this.encoding),
            ...(symbol.children ? { children: await Promise.all(symbol.children.map((child) => this.normalizeSymbol(child, file))) } : {}),
        };
    }
    relativeFile(file) {
        const relative = path.relative(this.config.workspace, file);
        return relative.startsWith("..") ? file : relative.split(path.sep).join("/");
    }
    async sendRequest(method, params) {
        if (!this.connection || this.exited)
            throw new CliError("CLANGD_EXITED", "clangd exited during the request", 3);
        return Promise.race([
            this.connection.sendRequest(method, params),
            this.exitPromise.then(() => {
                throw new CliError("CLANGD_EXITED", "clangd exited during the request", 3);
            }),
        ]);
    }
}
function languageId(file) {
    return /\.(c|h)$/iu.test(file) ? "c" : "cpp";
}
//# sourceMappingURL=clangd-session.js.map