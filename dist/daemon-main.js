import { Buffer } from "node:buffer";
import { Daemon } from "./daemon.js";
const encoded = process.argv[2];
if (!encoded) {
    process.stderr.write("clangd-cli daemon requires an encoded session configuration\n");
    process.exitCode = 2;
}
else {
    try {
        const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        await new Daemon(config).run();
    }
    catch (error) {
        process.stderr.write(`clangd-cli daemon failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
//# sourceMappingURL=daemon-main.js.map