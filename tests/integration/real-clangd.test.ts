import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentRequest, AgentResponse } from "../../src/protocol.js";

const project = path.join(process.cwd(), "tests", "fixtures", "cpp-project");
const build = path.join(project, "build");
const cli = path.join(process.cwd(), "dist", "cli.js");

function request(operation: AgentRequest["operation"], params?: Record<string, unknown>): AgentRequest {
  return {
    version: 1,
    operation,
    workspace: project,
    compileCommandsDir: build,
    timeoutMs: 30000,
    ...(params ? { params } : {}),
  };
}

async function runCli(input: AgentRequest): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as AgentResponse);
      } catch (error) {
        reject(new Error(`Invalid CLI response: ${stdout}\nstderr: ${stderr}`, { cause: error }));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function runRawCli(input: string): Promise<AgentResponse> {
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
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe", windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed (${String(code)}): ${output}`))));
  });
}

describe("real clangd daemon", { concurrency: false }, () => {
  before(async () => {
    await rm(build, { recursive: true, force: true });
    await runCommand("cmake", ["-S", project, "-B", build, "-G", "Ninja", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", "-DCMAKE_CXX_COMPILER=clang++"]);
    await runCli(request("stop"));
  });

  after(async () => {
    await runCli(request("stop"));
  });

  it("does not start a daemon for status", async () => {
    const response = await runCli(request("status"));
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { running: false });
  });

  it("accepts a UTF-8 BOM from PowerShell stdin", async () => {
    const response = await runRawCli(`\uFEFF${JSON.stringify(request("status"))}`);
    assert.equal(response.ok, true);
    assert.equal(response.operation, "status");
  });

  it("queries definitions and reuses the session", async () => {
    const definition = await runCli(request("definition", { file: "src/main.cpp", position: { line: 4, column: 10 } }));
    assert.equal(definition.ok, true);
    assert.equal(definition.meta.sessionReused, false);
    const definitionFile = (definition.result as { locations: Array<{ file: string }> }).locations[0]?.file;
    assert.ok(["include/calculator.h", "src/calculator.cpp"].includes(definitionFile ?? ""));

    const hover = await runCli(request("hover", { file: "src/main.cpp", position: { line: 4, column: 10 } }));
    assert.equal(hover.ok, true);
    assert.equal(hover.meta.sessionReused, true);
    assert.match(JSON.stringify(hover.result), /int/u);
  });

  it("returns references and document/workspace symbols", async () => {
    const references = await runCli(request("references", { file: "src/main.cpp", position: { line: 4, column: 10 } }));
    assert.equal(references.ok, true);
    assert.ok((references.result as { locations: unknown[] }).locations.length >= 2);

    const documentSymbols = await runCli(request("documentSymbols", { file: "src/calculator.cpp" }));
    assert.match(JSON.stringify(documentSymbols.result), /add/u);

    let workspaceSymbols: AgentResponse | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      workspaceSymbols = await runCli(request("workspaceSymbols", { query: "add" }));
      if (JSON.stringify(workspaceSymbols.result).includes("add")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(JSON.stringify(workspaceSymbols?.result), /add/u);
  });

  it("returns diagnostics and supports restart/status", async () => {
    const diagnostics = await runCli(request("diagnostics", { file: "src/broken.cpp" }));
    assert.equal(diagnostics.ok, true);
    assert.match(JSON.stringify(diagnostics.result), /does_not_exist/u);

    const before = await runCli(request("status"));
    const oldPid = (before.result as { clangdPid: number }).clangdPid;
    const restarted = await runCli(request("restart"));
    assert.equal(restarted.ok, true);
    assert.notEqual((restarted.result as { clangdPid: number }).clangdPid, oldPid);
  });
});
