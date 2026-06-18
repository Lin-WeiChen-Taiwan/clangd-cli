import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { AgentRequest, AgentResponse } from "../../src/protocol.js";

const cli = path.join(process.cwd(), "dist", "cli.js");
const crashingClangd = path.join(process.cwd(), "tests", "fixtures", "crashing-clangd.mjs");

async function invoke(input: AgentRequest): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.on("error", reject);
    child.on("exit", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as AgentResponse);
      } catch (error) {
        reject(new Error(`Invalid response: ${stdout}`, { cause: error }));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

describe("daemon recovery", () => {
  it("restarts clangd once when it exits during a request", { timeout: 30000 }, async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "clangd-cli-recovery-"));
    const marker = path.join(workspace, "crashed.marker");
    await writeFile(path.join(workspace, "main.cpp"), "int value = 1;\n", "utf8");
    const base = {
      version: 1 as const,
      workspace,
      clangdPath: process.execPath,
      clangdArgs: [crashingClangd, marker],
      timeoutMs: 10000,
    };
    try {
      const response = await invoke({ ...base, operation: "hover", params: { file: "main.cpp", position: { line: 1, column: 5 } } });
      assert.equal(response.ok, true);
      assert.equal((response.result as { contents: string }).contents, "recovered");
    } finally {
      await invoke({ ...base, operation: "stop" });
    }
  });

  it("allows concurrent first requests to share one daemon session", { timeout: 30000 }, async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "clangd-cli-concurrent-"));
    await writeFile(path.join(workspace, "main.cpp"), "int value = 1;\n", "utf8");
    const fake = path.join(process.cwd(), "tests", "fixtures", "fake-clangd.mjs");
    const base = {
      version: 1 as const,
      workspace,
      clangdPath: process.execPath,
      clangdArgs: [fake],
      timeoutMs: 10000,
    };
    try {
      const responses = await Promise.all([
        invoke({ ...base, operation: "hover", params: { file: "main.cpp", position: { line: 1, column: 5 } } }),
        invoke({ ...base, operation: "hover", params: { file: "main.cpp", position: { line: 1, column: 5 } } }),
      ]);
      assert.equal(responses.every((response) => response.ok), true);
      const status = await invoke({ ...base, operation: "status" });
      assert.equal(status.ok, true);
      assert.deepEqual(status.result, {
        running: true,
        daemonPid: (status.result as { daemonPid: number }).daemonPid,
        clangdPid: (status.result as { clangdPid: number }).clangdPid,
        clangdRunning: true,
        indexing: false,
      });
    } finally {
      await invoke({ ...base, operation: "stop" });
    }
  });
});
