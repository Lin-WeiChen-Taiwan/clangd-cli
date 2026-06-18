import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ClangdSession } from "../../src/clangd-session.js";
import { FileLogger } from "../../src/logger.js";

describe("clangd protocol session", () => {
  let session: ClangdSession | undefined;
  afterEach(async () => session?.stop());

  it("initializes, opens a document, and handles hover, definition, and diagnostics", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "clangd-cli-fake-"));
    await writeFile(path.join(workspace, "main.cpp"), "int value = 1;\n", "utf8");
    const fake = path.join(process.cwd(), "tests", "fixtures", "fake-clangd.mjs");
    session = new ClangdSession(
      { workspace, clangdPath: process.execPath, clangdArgs: [fake] },
      new FileLogger(path.join(workspace, "session.log")),
    );
    await session.start();

    const hover = await session.execute({ version: 1, operation: "hover", params: { file: "main.cpp", position: { line: 1, column: 5 } } });
    assert.equal((hover.result as { contents: { value: string } }).contents.value, "`int value`");

    const definition = await session.execute({ version: 1, operation: "definition", params: { file: "main.cpp", position: { line: 1, column: 5 } } });
    assert.deepEqual((definition.result as { locations: Array<{ file: string; range: { start: unknown } }> }).locations[0], {
      file: "main.cpp",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
    });

    const diagnostics = await session.execute({ version: 1, operation: "diagnostics", params: { file: "main.cpp" } });
    assert.deepEqual(diagnostics.result, { diagnostics: [] });
  });
});
