import { appendFile, rename, stat } from "node:fs/promises";
import type { Logger } from "vscode-jsonrpc";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export class FileLogger implements Logger {
  private writeChain = Promise.resolve();

  constructor(private readonly file: string) {}

  error(message: string): void {
    this.write("ERROR", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  log(message: string): void {
    this.write("DEBUG", message);
  }

  private write(level: string, message: string): void {
    this.writeChain = this.writeChain
      .then(async () => {
        await this.rotateIfNeeded();
        await appendFile(this.file, `${new Date().toISOString()} ${level} ${message}\n`, "utf8");
      })
      .catch(() => undefined);
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      if ((await stat(this.file)).size < MAX_LOG_BYTES) return;
      await rename(this.file, `${this.file}.1`).catch(async () => {
        const { rm } = await import("node:fs/promises");
        await rm(`${this.file}.1`, { force: true });
        await rename(this.file, `${this.file}.1`);
      });
    } catch {
      // The log does not exist yet.
    }
  }
}
