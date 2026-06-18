# clangd-cli

An agent-friendly JSON command-line interface for querying C and C++ projects through [clangd](https://clangd.llvm.org/).

clangd-cli accepts one JSON request on stdin and writes one JSON response to stdout. A per-workspace background daemon keeps clangd, its ASTs, preambles, and background index alive across CLI invocations.

[繁體中文說明](README.zh-TW.md)

## Requirements

- Node.js 22 or later
- clangd available on `PATH`, or an explicit `clangdPath`
- A C/C++ project, preferably with `compile_commands.json`

## Install from GitHub

Stable release:

```shell
npm install --global https://github.com/Lin-WeiChen-Taiwan/clangd-cli/archive/refs/tags/v0.1.0.tar.gz
```

Current main branch:

```shell
npm install --global https://github.com/Lin-WeiChen-Taiwan/clangd-cli/archive/refs/heads/main.tar.gz
```

This project is intentionally not published to the npm registry. Release tags contain the compiled `dist` artifacts, and npm installs the runtime dependencies from GitHub source archives. Archive URLs avoid inconsistent Git dependency extraction in npm 11 on Windows.

## Quick Start

PowerShell:

```powershell
@'
{
  "version": 1,
  "operation": "definition",
  "workspace": "C:\\repo\\my-project",
  "compileCommandsDir": "build",
  "params": {
    "file": "src/main.cpp",
    "position": { "line": 42, "column": 10 }
  }
}
'@ | clangd-cli
```

Bash:

```bash
printf '%s' '{
  "version": 1,
  "operation": "hover",
  "workspace": "/repo/my-project",
  "params": {
    "file": "src/main.cpp",
    "position": { "line": 42, "column": 10 }
  }
}' | clangd-cli
```

Example response:

```json
{
  "version": 1,
  "ok": true,
  "operation": "definition",
  "result": {
    "locations": [
      {
        "file": "include/widget.h",
        "range": {
          "start": { "line": 18, "column": 7 },
          "end": { "line": 18, "column": 13 }
        }
      }
    ]
  },
  "meta": {
    "workspace": "C:\\repo\\my-project",
    "durationMs": 12,
    "sessionReused": true,
    "indexing": false,
    "truncated": false
  }
}
```

Line and column values are 1-based. Columns count Unicode code points. Returned paths inside the workspace use forward slashes on every platform.

## Operations

| Operation | Required params | Description |
| --- | --- | --- |
| `definition` | `file`, `position` | Find symbol definitions. |
| `references` | `file`, `position`; optional `limit` | Find references, including declarations. Default limit: 200. |
| `hover` | `file`, `position` | Return type information and documentation. |
| `documentSymbols` | `file` | Return the hierarchical symbol tree for a document. |
| `workspaceSymbols` | `query`; optional `limit` | Search project symbols. Default limit: 100. |
| `diagnostics` | `file` | Wait for and return clangd diagnostics for a file. |
| `status` | none | Report daemon and clangd state without starting them. |
| `restart` | none | Restart the workspace's clangd process. |
| `stop` | none | Stop the workspace daemon and clangd process. |

`limit` may be at most 2000. Results report `meta.truncated` when a limit is applied.

## Request Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Protocol version; currently `1`. |
| `operation` | yes | One operation from the table above. |
| `workspace` | no | Workspace root. Defaults to the nearest `.git` ancestor, then cwd. |
| `compileCommandsDir` | no | Compilation database directory, relative to the workspace or absolute. |
| `clangdPath` | no | clangd executable. Defaults to `clangd`. |
| `clangdArgs` | no | Additional clangd arguments. |
| `timeoutMs` | no | Request timeout from 100 to 300000 ms. Defaults to 15000. |
| `params` | depends | Operation-specific parameters. |

The daemon always enables `--background-index` unless `clangdArgs` already contains a background-index option.

## Errors and Exit Codes

Errors are returned as JSON with `ok: false` and a stable `error.code`, `error.message`, and optional `error.details`.

- `0`: success
- `2`: invalid JSON, schema, arguments, or operation parameters
- `3`: workspace, daemon, IPC, or clangd environment failure
- `4`: query failure, invalid source position, missing file, or timeout

Protocol output is written only to stdout. clangd and daemon logs are stored under `%LOCALAPPDATA%\clangd-cli` on Windows, `$XDG_RUNTIME_DIR/clangd-cli` when available, or the operating system temporary directory.

## Current Limitations

- Files are read from disk; unsaved editor buffers and content overlays are not supported.
- Requests are read-only. Rename, code actions, and workspace edits are not supported.
- One CLI invocation accepts one request.
- clangd may return incomplete workspace results while background indexing is in progress; check `meta.indexing`.
- clangd-cli does not build projects or generate `compile_commands.json`.

## Development

```shell
npm install
npm run verify
```

The integration suite uses a fake language server plus a real clangd and a small CMake/Ninja fixture.

## License

MIT
