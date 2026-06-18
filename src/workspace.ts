import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentRequest, SessionConfig } from "./protocol.js";

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function discoverWorkspace(request: AgentRequest, cwd = process.cwd()): Promise<string> {
  if (request.workspace) return canonicalPath(path.resolve(cwd, request.workspace));

  const file = typeof request.params?.file === "string" ? request.params.file : undefined;
  let current = file ? path.dirname(path.resolve(cwd, file)) : path.resolve(cwd);
  const fallback = current;
  while (true) {
    if (await exists(path.join(current, ".git"))) return canonicalPath(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return canonicalPath(fallback);
}

export async function canonicalPath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

export async function resolveSessionConfig(request: AgentRequest, cwd = process.cwd()): Promise<SessionConfig> {
  const workspace = await discoverWorkspace(request, cwd);
  const compileCommandsDir = request.compileCommandsDir
    ? await canonicalPath(path.resolve(workspace, request.compileCommandsDir))
    : undefined;
  return {
    workspace,
    ...(compileCommandsDir ? { compileCommandsDir } : {}),
    clangdPath: request.clangdPath ?? "clangd",
    clangdArgs: request.clangdArgs ?? [],
  };
}

export function sessionId(config: SessionConfig): string {
  const normalized = JSON.stringify({
    workspace: normalizeForIdentity(config.workspace),
    compileCommandsDir: config.compileCommandsDir ? normalizeForIdentity(config.compileCommandsDir) : null,
    clangdPath: normalizeForIdentity(config.clangdPath),
    clangdArgs: config.clangdArgs,
  });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

function normalizeForIdentity(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
