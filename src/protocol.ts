import { Ajv, type JSONSchemaType } from "ajv";

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
] as const;

export type Operation = (typeof OPERATIONS)[number];

export interface AgentPosition {
  line: number;
  column: number;
}

export interface AgentRequest {
  version: 1;
  operation: Operation;
  workspace?: string;
  compileCommandsDir?: string;
  clangdPath?: string;
  clangdArgs?: string[];
  timeoutMs?: number;
  params?: Record<string, unknown>;
}

export interface SessionConfig {
  workspace: string;
  compileCommandsDir?: string;
  clangdPath: string;
  clangdArgs: string[];
}

export interface ResponseMeta {
  workspace: string;
  durationMs: number;
  sessionReused: boolean;
  indexing?: boolean;
  truncated?: boolean;
}

export interface AgentError {
  code: string;
  message: string;
  details?: unknown;
}

export interface AgentResponse {
  version: 1;
  ok: boolean;
  operation: Operation;
  result?: unknown;
  error?: AgentError;
  meta: ResponseMeta;
}

const requestSchema: JSONSchemaType<AgentRequest> = {
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
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 3,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parseRequest(value: unknown): AgentRequest {
  if (!validate(value)) {
    throw new CliError("INVALID_REQUEST", "Request does not match the clangd-cli schema", 2, validate.errors);
  }
  return value as AgentRequest;
}

export function requireParams(request: AgentRequest): Record<string, unknown> {
  return request.params ?? {};
}

export function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError("INVALID_PARAMS", `params.${name} must be a non-empty string`, 2);
  }
  return value;
}

export function requirePosition(params: Record<string, unknown>): AgentPosition {
  const value = params.position;
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isInteger((value as AgentPosition).line) ||
    !Number.isInteger((value as AgentPosition).column) ||
    (value as AgentPosition).line < 1 ||
    (value as AgentPosition).column < 1
  ) {
    throw new CliError("INVALID_PARAMS", "params.position must contain 1-based integer line and column", 2);
  }
  return value as AgentPosition;
}

export function optionalLimit(params: Record<string, unknown>, fallback: number): number {
  const value = params.limit;
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 2000) {
    throw new CliError("INVALID_PARAMS", "params.limit must be an integer from 1 to 2000", 2);
  }
  return value as number;
}
