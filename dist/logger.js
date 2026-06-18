import { appendFile, rename, stat } from "node:fs/promises";
const MAX_LOG_BYTES = 5 * 1024 * 1024;
export class FileLogger {
    file;
    writeChain = Promise.resolve();
    constructor(file) {
        this.file = file;
    }
    error(message) {
        this.write("ERROR", message);
    }
    warn(message) {
        this.write("WARN", message);
    }
    info(message) {
        this.write("INFO", message);
    }
    log(message) {
        this.write("DEBUG", message);
    }
    write(level, message) {
        this.writeChain = this.writeChain
            .then(async () => {
            await this.rotateIfNeeded();
            await appendFile(this.file, `${new Date().toISOString()} ${level} ${message}\n`, "utf8");
        })
            .catch(() => undefined);
    }
    async rotateIfNeeded() {
        try {
            if ((await stat(this.file)).size < MAX_LOG_BYTES)
                return;
            await rename(this.file, `${this.file}.1`).catch(async () => {
                const { rm } = await import("node:fs/promises");
                await rm(`${this.file}.1`, { force: true });
                await rename(this.file, `${this.file}.1`);
            });
        }
        catch {
            // The log does not exist yet.
        }
    }
}
//# sourceMappingURL=logger.js.map