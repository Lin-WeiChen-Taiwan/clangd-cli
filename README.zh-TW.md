# clangd-cli

clangd-cli 是提供給 Agent 使用的 C/C++ 語意查詢 CLI，底層透過 [clangd](https://clangd.llvm.org/) 分析專案。

每次執行從 stdin 接收一個 JSON request，並在 stdout 輸出一個 JSON response。工具會為每個 workspace 維持背景 daemon，讓多次 CLI 呼叫共用 clangd、AST、preamble 與背景索引。

[English README](README.md)

## 系統需求

- Node.js 22 以上
- `PATH` 中可找到 clangd，或在 request 指定 `clangdPath`
- C/C++ 專案，建議提供 `compile_commands.json`

## 從 GitHub 安裝

穩定版本：

```powershell
npm install --global https://github.com/Lin-WeiChen-Taiwan/clangd-cli/releases/download/v0.1.0/clangd-cli-0.1.0.tgz
```

開發版本：

```powershell
git clone https://github.com/Lin-WeiChen-Taiwan/clangd-cli.git
cd clangd-cli
npm ci
npm run build
npm install --global .
```

此專案不會發布到 npm registry。GitHub Release 會提供從 tag source 建置的 npm `.tgz` asset。產生的 `dist` 會包含在套件內，但不會提交到 Git。

## 快速開始

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

行號與欄位皆從 1 開始，欄位以 Unicode code point 計算。workspace 內的回傳路徑在所有平台都使用 `/`。

## 支援操作

| Operation | 必要 params | 說明 |
| --- | --- | --- |
| `definition` | `file`、`position` | 尋找符號定義。 |
| `references` | `file`、`position`；可選 `limit` | 尋找引用，預設最多 200 筆。 |
| `hover` | `file`、`position` | 查詢型別、函式簽名與文件。 |
| `documentSymbols` | `file` | 取得文件的階層式 symbols。 |
| `workspaceSymbols` | `query`；可選 `limit` | 搜尋整個專案的 symbols，預設最多 100 筆。 |
| `diagnostics` | `file` | 等待並取得 clangd diagnostics。 |
| `status` | 無 | 查詢 daemon/clangd 狀態，且不會因此啟動 daemon。 |
| `restart` | 無 | 重新啟動 workspace 的 clangd。 |
| `stop` | 無 | 關閉 workspace daemon 與 clangd。 |

`limit` 最大為 2000；結果被截斷時會回傳 `meta.truncated: true`。

## Request 共用欄位

- `version`：目前固定為 `1`。
- `operation`：要執行的操作。
- `workspace`：可省略；預設向上尋找 `.git`，找不到時使用 cwd。
- `compileCommandsDir`：可省略；相對路徑以 workspace 為基準。
- `clangdPath`：可省略；預設為 `clangd`。
- `clangdArgs`：額外 clangd arguments。
- `timeoutMs`：100 到 300000，預設 15000。
- `params`：各 operation 的參數。

除非 `clangdArgs` 已指定 background-index 選項，daemon 會自動加入 `--background-index`。

## 錯誤與 Exit Code

錯誤仍會回傳合法 JSON，其中包含 `ok: false`、穩定的 `error.code`、`error.message` 與可選 details。

- `0`：成功
- `2`：JSON、schema、命令列或 operation params 錯誤
- `3`：workspace、daemon、IPC 或 clangd 環境錯誤
- `4`：查詢錯誤、無效位置、檔案不存在或 timeout

stdout 只輸出 protocol JSON。Windows logs 位於 `%LOCALAPPDATA%\clangd-cli`；Linux/macOS 優先使用 `$XDG_RUNTIME_DIR/clangd-cli`，否則使用系統暫存目錄。

## 第一版限制

- 只分析磁碟上的檔案，不支援尚未儲存的 editor buffer 或 content overlay。
- 只提供唯讀操作，不支援 rename、code action 或套用 workspace edit。
- 每次 CLI 執行只接受一個 request。
- 背景索引尚未完成時，workspace 查詢結果可能不完整，可查看 `meta.indexing`。
- 不負責編譯專案或產生 `compile_commands.json`。

## 開發與測試

```powershell
npm install
npm run verify
```

整合測試同時涵蓋 fake language server、真實 clangd 與小型 CMake/Ninja C++ fixture。

## 授權

MIT
