---
name: clangd-cli
description: Query and navigate C and C++ codebases through clangd-cli's stdin/stdout JSON interface. Use when Codex needs semantic symbol search, definitions, references, hover or type information, document or workspace symbols, clangd diagnostics, or clangd daemon status/restart/stop operations, especially when text search is insufficient and a compilation database is available.
---

# clangd-cli

Use `clangd-cli` as a read-only semantic companion to targeted file reads and `rg`. Let clangd resolve C/C++ templates, overloads, macros, declarations, and cross-file references instead of inferring them from text alone.

## Prepare

1. Confirm `clangd-cli --version` and `clangd --version` work.
2. Identify the workspace root. Prefer the repository root.
3. Locate `compile_commands.json` with `rg --files -g compile_commands.json`. Pass its containing directory as `compileCommandsDir` when it is outside the workspace root.
4. Ensure queried files are saved to disk. The tool does not accept unsaved overlays.

If `clangd-cli` is unavailable but this source repository is present, run `npm ci`, `npm run build`, and invoke `node dist/cli.js`. Otherwise install the `.tgz` asset from the latest GitHub Release. Do not use GitHub source archives as installable packages.

## Send Requests

Send exactly one JSON object on stdin and parse exactly one JSON object from stdout. Build JSON with a structured serializer; do not hand-escape paths or embed ad hoc JSON strings.

PowerShell pattern:

```powershell
$request = @{
  version = 1
  operation = "definition"
  workspace = "C:\repo\project"
  compileCommandsDir = "build"
  timeoutMs = 30000
  params = @{
    file = "src/main.cpp"
    position = @{ line = 42; column = 10 }
  }
} | ConvertTo-Json -Depth 8 -Compress

$response = $request | clangd-cli | ConvertFrom-Json
if (-not $response.ok) { throw "$($response.error.code): $($response.error.message)" }
```

Bash pattern:

```bash
jq -nc \
  --arg workspace "$PWD" \
  '{version:1, operation:"workspaceSymbols", workspace:$workspace,
    params:{query:"Widget", limit:100}}' \
  | clangd-cli
```

Positions are 1-based and columns count Unicode code points. Send file paths relative to the workspace when possible. Returned in-workspace paths always use `/`.

## Choose an Operation

| Need | Operation | Params |
| --- | --- | --- |
| Locate a known symbol globally | `workspaceSymbols` | `query`, optional `limit` |
| Inspect symbols in one file | `documentSymbols` | `file` |
| Resolve a symbol at a position | `definition` | `file`, `position` |
| Find usages | `references` | `file`, `position`, optional `limit` |
| Inspect type, signature, or docs | `hover` | `file`, `position` |
| Read compiler-style issues | `diagnostics` | `file` |
| Inspect session state | `status` | none |
| Recover a stale clangd session | `restart` | none |
| End the workspace session | `stop` | none |

Default limits are 100 workspace symbols and 200 references; the maximum is 2000. Prefer narrow queries before raising limits.

## Work Semantically

- Use `workspaceSymbols` to discover candidate locations, then use `definition`, `hover`, or `references` at an exact position.
- Read only the returned files and relevant ranges after a query. The CLI returns semantic locations, not source snippets.
- Keep `workspace`, `compileCommandsDir`, `clangdPath`, and `clangdArgs` identical across related requests so they reuse one daemon session.
- Check `meta.truncated`; rerun with a larger `limit` only when the omitted results matter.
- Check `meta.indexing`; if a global query is unexpectedly empty while indexing is active, wait briefly and retry before concluding that no symbol exists.
- Increase `timeoutMs` for first queries on large projects. Keep it between 100 and 300000.
- Do not stop the daemon after every query. Let it retain clangd's AST, preamble, and index caches; stop it when cleanup is requested.

## Handle Failures

Always branch on `ok`, not only the process exit code.

- `INVALID_REQUEST` or `INVALID_PARAMS`: fix the JSON shape, operation params, or 1-based position.
- `FILE_NOT_FOUND`: resolve the path against the selected workspace.
- `INVALID_POSITION`: reread the saved file and recompute the line and column.
- `CLANGD_NOT_FOUND`: locate clangd and pass `clangdPath`, or install LLVM.
- `REQUEST_TIMEOUT`: retry with a larger timeout; inspect `status` before restarting.
- Inaccurate diagnostics or navigation: verify `compile_commands.json`, include paths, macros, and language standard before blaming clangd.

Logs live under `%LOCALAPPDATA%\clangd-cli` on Windows, `$XDG_RUNTIME_DIR/clangd-cli` when available, or the system temporary directory.

## Respect Boundaries

Do not use this skill for building, linking, generating `compile_commands.json`, applying edits, rename/code actions, runtime debugging, breakpoints, or DAP tasks. Use the project's build system for compilation and a debugger-oriented workflow for runtime state.
