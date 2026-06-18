#!/usr/bin/env node
let input = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { positionEncoding: "utf-8" } } });
  } else if (message.method === "textDocument/didOpen") {
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, version: 1, diagnostics: [] } });
  } else if (message.method === "textDocument/hover") {
    send({ jsonrpc: "2.0", id: message.id, result: { contents: { kind: "markdown", value: "`int value`" } } });
  } else if (message.method === "textDocument/definition") {
    send({ jsonrpc: "2.0", id: message.id, result: { uri: message.params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } } });
  } else if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
  } else if (message.method === "exit") {
    process.exit(0);
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length: (\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (input.length < bodyStart + length) return;
    const message = JSON.parse(input.subarray(bodyStart, bodyStart + length).toString("utf8"));
    input = input.subarray(bodyStart + length);
    handle(message);
  }
});
