import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AgentRequest, AgentResponse, SessionConfig } from "./protocol.js";
import { CliError } from "./protocol.js";
import { sessionId } from "./workspace.js";

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

export function runtimeRoot(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "clangd-cli");
  }
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, "clangd-cli");
  return path.join(os.tmpdir(), `clangd-cli-${process.getuid?.() ?? "user"}`);
}

export function sessionPaths(config: SessionConfig): SessionPaths {
  const id = sessionId(config);
  const directory = path.join(runtimeRoot(), id);
  return {
    directory,
    endpoint: process.platform === "win32" ? `\\\\.\\pipe\\clangd-cli-${id}` : path.join(directory, "daemon.sock"),
    lock: path.join(directory, "daemon.lock"),
    metadata: path.join(directory, "session.json"),
    log: path.join(directory, "daemon.log"),
  };
}

export async function ensureSessionDirectory(paths: SessionPaths): Promise<void> {
  await mkdir(paths.directory, { recursive: true });
}

export async function writeMetadata(paths: SessionPaths, metadata: SessionMetadata): Promise<void> {
  await writeFile(paths.metadata, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export async function readMetadata(paths: SessionPaths): Promise<SessionMetadata | undefined> {
  try {
    return JSON.parse(await readFile(paths.metadata, "utf8")) as SessionMetadata;
  } catch {
    return undefined;
  }
}

export async function removeSessionArtifacts(paths: SessionPaths): Promise<void> {
  await Promise.allSettled([
    rm(paths.metadata, { force: true }),
    rm(paths.lock, { force: true }),
    ...(process.platform === "win32" ? [] : [rm(paths.endpoint, { force: true })]),
  ]);
}

export async function sendIpcRequest(
  endpoint: string,
  request: AgentRequest,
  timeoutMs: number,
): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CliError("IPC_TIMEOUT", `Daemon did not respond within ${timeoutMs}ms`, 3));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as AgentResponse);
      } catch (error) {
        reject(new CliError("INVALID_DAEMON_RESPONSE", "Daemon returned invalid JSON", 3, String(error)));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("end", () => {
      if (!buffer.includes("\n")) {
        clearTimeout(timer);
        reject(new CliError("EMPTY_DAEMON_RESPONSE", "Daemon closed without a response", 3));
      }
    });
  });
}
