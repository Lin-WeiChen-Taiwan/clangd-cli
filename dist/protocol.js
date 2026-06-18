import { Ajv } from "ajv";
export const OPERATIONS = [
    "definition",
    "references",
    "hover",
    "documentSymbols",
    "workspaceSymbols",
    "diagnostics",
    "status",
    "stop",
    "restart",
];
const requestSchema = {
    type: "object",
    additionalProperties: false,
    required: ["version", "operation"],
    properties: {
        version: { type: "integer", const: 1 },
        operation: { type: "string", enum: [...OPERATIONS] },
        workspace: { type: "string", nullable: true },
        compileCommandsDir: { type: "string", nullable: true },
        clangdPath: { type: "string", nullable: true },
        clangdArgs: { type: "array", items: { type: "string" }, nullable: true },
        timeoutMs: { type: "integer", minimum: 100, maximum: 300000, nullable: true },
        params: { type: "object", required: [], additionalProperties: true, nullable: true },
    },
};
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(requestSchema);
export class CliError extends Error {
    code;
    exitCode;
    details;
    constructor(code, message, exitCode = 3, details) {
        super(message);
        this.code = code;
        this.exitCode = exitCode;
        this.details = details;
    }
}
export function parseRequest(value) {
    if (!validate(value)) {
        throw new CliError("INVALID_REQUEST", "Request does not match the clangd-cli schema", 2, validate.errors);
    }
    return value;
}
export function requireParams(request) {
    return request.params ?? {};
}
export function requireString(params, name) {
    const value = params[name];
    if (typeof value !== "string" || value.length === 0) {
        throw new CliError("INVALID_PARAMS", `params.${name} must be a non-empty string`, 2);
    }
    return value;
}
export function requirePosition(params) {
    const value = params.position;
    if (typeof value !== "object" ||
        value === null ||
        !Number.isInteger(value.line) ||
        !Number.isInteger(value.column) ||
        value.line < 1 ||
        value.column < 1) {
        throw new CliError("INVALID_PARAMS", "params.position must contain 1-based integer line and column", 2);
    }
    return value;
}
export function optionalLimit(params, fallback) {
    const value = params.limit;
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < 1 || value > 2000) {
        throw new CliError("INVALID_PARAMS", "params.limit must be an integer from 1 to 2000", 2);
    }
    return value;
}
//# sourceMappingURL=protocol.js.map