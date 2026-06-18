import type { Logger } from "vscode-jsonrpc";
export declare class FileLogger implements Logger {
    private readonly file;
    private writeChain;
    constructor(file: string);
    error(message: string): void;
    warn(message: string): void;
    info(message: string): void;
    log(message: string): void;
    private write;
    private rotateIfNeeded;
}
