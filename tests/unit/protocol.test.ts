import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CliError, optionalLimit, parseRequest, requirePosition } from "../../src/protocol.js";

describe("agent protocol", () => {
  it("accepts a valid request", () => {
    assert.equal(parseRequest({ version: 1, operation: "hover", params: { file: "main.cpp", position: { line: 1, column: 1 } } }).operation, "hover");
  });

  it("rejects unknown operations and properties", () => {
    assert.throws(() => parseRequest({ version: 1, operation: "compile" }), CliError);
    assert.throws(() => parseRequest({ version: 1, operation: "hover", extra: true }), CliError);
  });

  it("validates positions and limits", () => {
    assert.deepEqual(requirePosition({ position: { line: 2, column: 3 } }), { line: 2, column: 3 });
    assert.throws(() => requirePosition({ position: { line: 0, column: 1 } }), /1-based/u);
    assert.equal(optionalLimit({}, 100), 100);
    assert.equal(optionalLimit({ limit: 2000 }, 100), 2000);
    assert.throws(() => optionalLimit({ limit: 2001 }, 100), /2000/u);
  });
});
