#!/usr/bin/env node
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { CliError, OPERATIONS, parseRequest, type AgentRequest, type AgentResponse, type Operation } from "./protocol.js";
import { ensureSessionDirectory, readMetadata, sendIpcRequest, sessionPaths } from "./ipc.js";
import { resolveSessionConfig } from "./workspace.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(helpText());
    return;
  }
  if (process.argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (process.argv.length > 2) throw new CliError("INVALID_ARGUMENT", "Only --help and --version are supported; send requests through stdin", 2);

  const raw = (await readStdin()).replace(/^\uFEFF/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError("INVALID_JSON", "stdin must contain one JSON object", 2, String(error));
  }
  const request = parseRequest(parsed);
  const config = await resolveSessionConfig(request);
  const paths = sessionPaths(config);
  const timeoutMs = request.timeoutMs ?? 15000;
  let reused = false;

  try {
    const metadata = await readMetadata(paths);
    if (metadata) {
      try {
        const response = await sendIpcRequest(paths.endpoint, request, timeoutMs);
        writeResponse(response);
        return;
      } catch {
        // Stale metadata is recovered by starting a fresh daemon.
      }
    }

    if (request.operation === "status" || request.operation === "stop") {
      writeResponse(notRunningResponse(request.operation, config.workspace));
      return;
    }

    await startDaemon(config);
    reused = false;
    const response = await waitForDaemon(paths.endpoint, request, timeoutMs);
    writeResponse(response);
  } catch (error) {
    writeResponse(errorResponse(request.operation, config.workspace, toCliError(error), reused));
  }
}

async function startDaemon(config: Awaited<ReturnType<typeof resolveSessionConfig>>): Promise<void> {
  const paths = sessionPaths(config);
  await ensureSessionDirectory(paths);
  const daemonEntry = fileURLToPath(new URL("./daemon-main.js", import.meta.url));
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
  const child = spawn(process.execPath, [daemonEntry, encoded], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

async function waitForDaemon(endpoint: string, request: AgentRequest, timeoutMs: number): Promise<AgentResponse> {
  const deadline = Date.now() + Math.min(timeoutMs, 10000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await probeEndpoint(endpoint);
      return await sendIpcRequest(endpoint, request, timeoutMs + 1000);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new CliError("DAEMON_START_TIMEOUT", "Daemon did not become ready", 3, String(lastError));
}

async function probeEndpoint(endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });
}

function writeResponse(response: AgentResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = exitCodeFor(response.error?.code);
}

function notRunningResponse(operation: Operation, workspace: string): AgentResponse {
  return {
    version: 1,
    ok: true,
    operation,
    result: operation === "status" ? { running: false } : { stopped: false },
    meta: { workspace, durationMs: 0, sessionReused: false, indexing: false },
  };
}

function errorResponse(operation: Operation, workspace: string, error: CliError, reused: boolean): AgentResponse {
  return {
    version: 1,
    ok: false,
    operation,
    error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
    meta: { workspace, durationMs: 0, sessionReused: reused, indexing: false },
  };
}

function toCliError(error: unknown): CliError {
  return error instanceof CliError ? error : new CliError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), 3);
}

function exitCodeFor(code?: string): number {
  if (code === "INVALID_JSON" || code === "INVALID_REQUEST" || code === "INVALID_PARAMS" || code === "INVALID_ARGUMENT") return 2;
  if (code === "REQUEST_TIMEOUT" || code === "FILE_NOT_FOUND" || code === "INVALID_POSITION") return 4;
  return 3;
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  if (!value.trim()) throw new CliError("INVALID_JSON", "stdin is empty", 2);
  return value;
}

function helpText(): string {
  return `clangd-cli ${VERSION}\n\nAgent-friendly JSON interface to clangd.\n\nUsage:\n  echo '<request-json>' | clangd-cli\n  clangd-cli --help\n  clangd-cli --version\n\nOperations:\n  ${OPERATIONS.join(", ")}\n\nRequests use 1-based line and column positions.\n`;
}

try {
  await main();
} catch (error) {
  const cliError = toCliError(error);
  const response = errorResponse("status", process.cwd(), cliError, false);
  writeResponse(response);
}
