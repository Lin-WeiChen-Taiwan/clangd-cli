import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalPath, discoverWorkspace, sessionId } from "../../src/workspace.js";

describe("workspace discovery", () => {
  it("walks upward to a git root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clangd-cli-workspace-"));
    await mkdir(path.join(root, ".git"));
    const nested = path.join(root, "src", "nested");
    await mkdir(nested, { recursive: true });
    assert.equal(await discoverWorkspace({ version: 1, operation: "status" }, nested), await canonicalPath(root));
  });

  it("uses all session settings in the identity", () => {
    const base = { workspace: "/tmp/project", clangdPath: "clangd", clangdArgs: [] };
    assert.notEqual(sessionId(base), sessionId({ ...base, clangdArgs: ["--clang-tidy"] }));
  });
});
