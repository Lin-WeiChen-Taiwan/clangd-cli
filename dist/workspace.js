import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
async function exists(candidate) {
    try {
        await access(candidate);
        return true;
    }
    catch {
        return false;
    }
}
export async function discoverWorkspace(request, cwd = process.cwd()) {
    if (request.workspace)
        return canonicalPath(path.resolve(cwd, request.workspace));
    const file = typeof request.params?.file === "string" ? request.params.file : undefined;
    let current = file ? path.dirname(path.resolve(cwd, file)) : path.resolve(cwd);
    const fallback = current;
    while (true) {
        if (await exists(path.join(current, ".git")))
            return canonicalPath(current);
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return canonicalPath(fallback);
}
export async function canonicalPath(candidate) {
    const absolute = path.resolve(candidate);
    try {
        return await realpath(absolute);
    }
    catch {
        return absolute;
    }
}
export async function resolveSessionConfig(request, cwd = process.cwd()) {
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
export function sessionId(config) {
    const normalized = JSON.stringify({
        workspace: normalizeForIdentity(config.workspace),
        compileCommandsDir: config.compileCommandsDir ? normalizeForIdentity(config.compileCommandsDir) : null,
        clangdPath: normalizeForIdentity(config.clangdPath),
        clangdArgs: config.clangdArgs,
    });
    return createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}
function normalizeForIdentity(value) {
    return process.platform === "win32" ? value.toLowerCase() : value;
}
//# sourceMappingURL=workspace.js.map