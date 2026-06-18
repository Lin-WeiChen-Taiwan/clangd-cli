import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromLspPosition, toLspPosition } from "../../src/position.js";

describe("position conversion", () => {
  const content = "abc\nA😀B\n";

  it("converts one-based Unicode columns to UTF-8", () => {
    assert.deepEqual(toLspPosition(content, { line: 2, column: 3 }, "utf-8"), { line: 1, character: 5 });
  });

  it("converts one-based Unicode columns to UTF-16", () => {
    assert.deepEqual(toLspPosition(content, { line: 2, column: 3 }, "utf-16"), { line: 1, character: 3 });
  });

  it("round trips protocol positions", () => {
    assert.deepEqual(fromLspPosition(content.split("\n")[1]!, { line: 0, character: 5 }, "utf-8"), { line: 1, column: 3 });
  });
});
