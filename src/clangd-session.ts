import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import type { Diagnostic, DocumentSymbol, Location, LocationLink, Position, Range, SymbolInformation } from "vscode-languageserver-protocol";
import { FileLogger } from "./logger.js";
import { fromLspPosition, normalizeRange, toLspPosition, type PositionEncoding } from "./position.js";
import { CliError, optionalLimit, requireParams, requirePosition, requireString, type AgentRequest, type SessionConfig } from "./protocol.js";

interface OpenDocument {
  content: string;
  version: number;
  touched: number;
}

interface DiagnosticState {
  diagnostics: Diagnostic[];
  version?: number;
}

interface InitializeResult {
  capabilities?: { positionEncoding?: PositionEncoding };
}

export interface OperationResult {
  result: unknown;
  truncated?: boolean;
  indexing: boolean;
}

export class ClangdSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private connection: MessageConnection | undefined;
  private documents = new Map<string, OpenDocument>();
  private diagnostics = new Map<string, DiagnosticState>();
  private diagnosticWaiters = new Map<string, Array<(value: DiagnosticState) => void>>();
  private progressTokens = new Set<string | number>();
  private encoding: PositionEncoding = "utf-16";
  private stopping = false;
  private exited = false;
  private exitPromise: Promise<void> = Promise.resolve();
  private resolveExit: (() => void) | undefined;

  constructor(
    private readonly config: SessionConfig,
    private readonly logger: FileLogger,
  ) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get indexing(): boolean {
    return this.progressTokens.size > 0;
  }

  get alive(): boolean {
    return Boolean(this.child && !this.exited);
  }

  async start(): Promise<void> {
    if (this.alive) return;
    this.stopping = false;
    this.exited = false;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    const args = [...this.config.clangdArgs];
    if (!args.some((argument) => argument.startsWith("--background-index"))) args.push("--background-index");
    if (this.config.compileCommandsDir) args.push(`--compile-commands-dir=${this.config.compileCommandsDir}`);

    this.logger.info(`Starting ${this.config.clangdPath} ${args.join(" ")}`);
    const child = spawn(this.config.clangdPath, args, {
      cwd: this.config.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.logger.log(`[clangd] ${chunk.trimEnd()}`));
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.resolveExit?.();
      this.logger.warn(`clangd exited code=${String(code)} signal=${String(signal)}`);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(new CliError("CLANGD_NOT_FOUND", `Failed to start clangd: ${error.message}`, 3));
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
    })) as InitializeResult;
    this.encoding = initialized.capabilities?.positionEncoding ?? "utf-16";
    await connection.sendNotification("initialized", {});
    this.logger.info(`clangd initialized with ${this.encoding} positions`);
  }

  async execute(request: AgentRequest): Promise<OperationResult> {
    if (!this.connection || !this.alive) throw new CliError("CLANGD_EXITED", "clangd is not running", 3);
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

  async stop(): Promise<void> {
    if (!this.child) return;
    this.stopping = true;
    try {
      if (this.connection && !this.exited) {
        await Promise.race([
          this.connection.sendRequest("shutdown", null),
          new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), 2000)),
        ]);
        await this.connection.sendNotification("exit");
      }
    } catch {
      // Force termination below.
    }
    if (!this.exited) this.child.kill();
    this.connection?.dispose();
    this.connection = undefined;
    this.child = undefined;
    this.documents.clear();
    this.diagnostics.clear();
  }

  private installHandlers(connection: MessageConnection): void {
    connection.onRequest((method, params) => {
      if (method === "workspace/configuration") {
        const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
        return items.map(() => null);
      }
      if (method === "workspace/applyEdit") return { applied: false, failureReason: "clangd-cli is read-only" };
      return null;
    });
    connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[]; version?: number }) => {
      const state: DiagnosticState = {
        diagnostics: params.diagnostics,
        ...(params.version === undefined ? {} : { version: params.version }),
      };
      this.diagnostics.set(params.uri, state);
      for (const resolve of this.diagnosticWaiters.get(params.uri) ?? []) resolve(state);
      this.diagnosticWaiters.delete(params.uri);
    });
    connection.onNotification("$/progress", (params: { token: string | number; value?: { kind?: string } }) => {
      if (params.value?.kind === "begin") this.progressTokens.add(params.token);
      if (params.value?.kind === "end") this.progressTokens.delete(params.token);
    });
    connection.onUnhandledNotification((message) => this.logger.log(`Unhandled notification ${message.method}`));
  }

  private async ensureDocument(fileValue: string): Promise<{ file: string; uri: string; content: string }> {
    const file = path.resolve(this.config.workspace, fileValue);
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      throw new CliError("FILE_NOT_FOUND", `Cannot read source file: ${file}`, 4, String(error));
    }
    const uri = pathToFileURL(file).href;
    const existing = this.documents.get(file);
    if (!existing) {
      this.documents.set(file, { content, version: 1, touched: Date.now() });
      this.diagnostics.delete(uri);
      await this.connection!.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(file), version: 1, text: content },
      });
    } else if (existing.content !== content) {
      existing.content = content;
      existing.version += 1;
      existing.touched = Date.now();
      this.diagnostics.delete(uri);
      await this.connection!.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text: content }],
      });
    } else {
      existing.touched = Date.now();
    }
    await this.evictDocuments();
    return { file, uri, content };
  }

  private async evictDocuments(): Promise<void> {
    if (this.documents.size <= 32) return;
    const entries = [...this.documents.entries()].sort((a, b) => a[1].touched - b[1].touched);
    for (const [file] of entries.slice(0, this.documents.size - 32)) {
      this.documents.delete(file);
      await this.connection!.sendNotification("textDocument/didClose", { textDocument: { uri: pathToFileURL(file).href } });
    }
  }

  private async textPositionParams(params: Record<string, unknown>): Promise<{ document: { file: string; uri: string; content: string }; position: Position }> {
    const document = await this.ensureDocument(requireString(params, "file"));
    return { document, position: toLspPosition(document.content, requirePosition(params), this.encoding) };
  }

  private async locationRequest(method: string, params: Record<string, unknown>, limit: number, context?: unknown): Promise<OperationResult> {
    const { document, position } = await this.textPositionParams(params);
    const response = await this.sendRequest(method, {
      textDocument: { uri: document.uri },
      position,
      ...(context ? { context } : {}),
    });
    const values = response === null ? [] : Array.isArray(response) ? response : [response];
    const sliced = values.slice(0, limit) as Array<Location | LocationLink>;
    return {
      result: { locations: await Promise.all(sliced.map((location) => this.normalizeLocation(location))) },
      truncated: values.length > limit,
      indexing: this.indexing,
    };
  }

  private async hover(params: Record<string, unknown>): Promise<OperationResult> {
    const { document, position } = await this.textPositionParams(params);
    const response = (await this.sendRequest("textDocument/hover", {
      textDocument: { uri: document.uri },
      position,
    })) as { contents?: unknown; range?: Range } | null;
    if (!response) return { result: null, indexing: this.indexing };
    return {
      result: {
        contents: response.contents,
        ...(response.range ? { range: await normalizeRange(document.file, response.range, this.encoding) } : {}),
      },
      indexing: this.indexing,
    };
  }

  private async documentSymbols(params: Record<string, unknown>): Promise<OperationResult> {
    const document = await this.ensureDocument(requireString(params, "file"));
    const response = (await this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: document.uri },
    })) as Array<DocumentSymbol | SymbolInformation> | null;
    const symbols = await Promise.all((response ?? []).map((symbol) => this.normalizeSymbol(symbol, document.file)));
    return { result: { symbols }, indexing: this.indexing };
  }

  private async workspaceSymbols(params: Record<string, unknown>): Promise<OperationResult> {
    const query = requireString(params, "query");
    const limit = optionalLimit(params, 100);
    const response = (await this.sendRequest("workspace/symbol", { query })) as SymbolInformation[] | null;
    const values = response ?? [];
    return {
      result: { symbols: await Promise.all(values.slice(0, limit).map((symbol) => this.normalizeSymbol(symbol))) },
      truncated: values.length > limit,
      indexing: this.indexing,
    };
  }

  private async getDiagnostics(params: Record<string, unknown>): Promise<OperationResult> {
    const document = await this.ensureDocument(requireString(params, "file"));
    const state = this.diagnostics.get(document.uri) ?? (await new Promise<DiagnosticState>((resolve) => {
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

  private async normalizeLocation(value: Location | LocationLink): Promise<unknown> {
    const uri = "uri" in value ? value.uri : value.targetUri;
    const range = "range" in value ? value.range : value.targetSelectionRange;
    const file = fileURLToPath(uri);
    return { file: this.relativeFile(file), range: await normalizeRange(file, range, this.encoding) };
  }

  private async normalizeSymbol(symbol: DocumentSymbol | SymbolInformation, defaultFile?: string): Promise<unknown> {
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

  private relativeFile(file: string): string {
    const relative = path.relative(this.config.workspace, file);
    return relative.startsWith("..") ? file : relative.split(path.sep).join("/");
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.connection || this.exited) throw new CliError("CLANGD_EXITED", "clangd exited during the request", 3);
    return Promise.race([
      this.connection.sendRequest(method, params),
      this.exitPromise.then(() => {
        throw new CliError("CLANGD_EXITED", "clangd exited during the request", 3);
      }),
    ]);
  }
}

function languageId(file: string): string {
  return /\.(c|h)$/iu.test(file) ? "c" : "cpp";
}
