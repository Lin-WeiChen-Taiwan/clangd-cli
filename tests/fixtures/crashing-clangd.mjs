#!/usr/bin/env node
import fs from "node:fs";

const marker = process.argv[2];
let input = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { positionEncoding: "utf-8" } } });
  } else if (message.method === "textDocument/hover") {
    if (marker && !fs.existsSync(marker)) {
      fs.writeFileSync(marker, "crashed", "utf8");
      process.exit(42);
    }
    send({ jsonrpc: "2.0", id: message.id, result: { contents: "recovered" } });
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
    const match = /Content-Length: (\d+)/i.exec(input.subarray(0, headerEnd).toString("ascii"));
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (input.length < start + length) return;
    const message = JSON.parse(input.subarray(start, start + length).toString("utf8"));
    input = input.subarray(start + length);
    handle(message);
  }
});
