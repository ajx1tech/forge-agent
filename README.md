# Forge Agent (TrueFoundry Forge-a-thon)

VS Code AI software engineering agent extension built natively on **TrueForge** for the TrueFoundry Forge-a-thon at Techfest IIT Bombay.

## Declared Fork Point
- **Fork Point**: `None - written from scratch`
- The entire codebase—including context retrieval, in-memory staging changeset, per-hunk VS Code diff review, Activity Bar webview UI, cancellation state machine, and multi-model resilience—was written completely from scratch for this hackathon.

---

## 1. Clean-Clone Setup

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Python**: 3.10 or higher (for demo workspace pytest verification)
- **VS Code**: 1.90.0 or higher
- **TrueForge**: v0.185.1 running locally (or reachable at `http://localhost:8790`)

### Installation & Build
```bash
# Clone the repository and enter directory
git clone <repository-url>
cd forge-agent

# Install dependencies
npm install

# Build the extension bundle (esbuild)
npm run build

# Run unit tests
npx vitest run --testTimeout=5000
```

### Demo Workspace Setup
To set up the Pallets Flask 3.1.3 target demo repository:
```powershell
# Set up Flask 3.1.3 in .demo/flask with virtualenv and baseline pytest pass
.\scripts\setup-flask.ps1

# To reset the demo workspace back to pristine state at any time:
.\scripts\demo-reset.ps1
```

---

## 2. TrueForge Startup & Architecture

TrueForge runs locally as the central agent orchestration and model gateway:
1. Start TrueForge server locally:
   ```bash
   trueforge start --port 8790
   ```
2. The extension automatically registers the **Streamable HTTP MCP connector** (`forge-editor`) at:
   - URL: `http://127.0.0.1:8799/mcp`
   - Authentication: Dynamic Bearer token stored securely in `vscode.SecretStorage`.
3. Agent definitions are registered from `agents/forge-agent.json` and `agents/forge-inline.json`.
4. Zero direct calls to external LLM providers exist in the extension; all reasoning, turns, tool loops, and streaming pass strictly through `@truefoundry/trueforge-sdk`.

---

## 3. Model Configuration

Models are configured via `trueforge.config.example.json` or VS Code settings under `forge.models`:

```json
{
  "baseUrl": "http://localhost:8790",
  "models": [
    "google-gemini/<primary-model-id>",
    "custom/<groq-model-id>"
  ],
  "mcpPort": 8799,
  "contextBudgetTokens": 8000
}
```

- **Primary Model**: `google-gemini/<primary-model-id>` (rich reasoning, repo-scale multi-file context)
- **Fallback / Inline Model**: `custom/<groq-model-id>` (fast response, low latency inline edits and automatic failover target)

---

## 4. Feature Flow: Tasks A, B, and C

### Task A: Backend, Context Engine & Safe MCP Tools
- **Offline Context Engine**: Custom token-budgeted BM25 search engine with identifier splitting (snake, camel, Pascal, dotted), 3x symbol boost, 2x path boost, and 1-hop companion linking (`src/**/X.py` <-> `tests/test_X.py` <-> `docs/X.rst`).
- **Token Budget Packing**: Context packing cap at 6,000 tokens, 1,500-token repo-map, and 8,000-token turn cap with footer tracking.
- **Safety Policy & Safe MCP Tools**:
  - `repo_map`: Token-budgeted hierarchy generator.
  - `search_workspace`: Fast text, regex, path, and symbol search.
  - `read_file`: Line-numbered, 400-line cap with continuation hints and staged overlay hook.
  - `run_command`: Strict command allowlist (`pytest`, `python`, `flask`, `git`, `ls`, `rg`), blocking command chaining, directory traversal, and `.env*` access.
  - `retrieve_context`: BM25-ranked snippet packing.

### Task B: In-Memory ChangeSet, Diff Review, Webview Panel & Inline Edit
- **Zero Silent Disk Writes**: `stage_edit` writes exclusively to an in-memory `ChangeSet`. Target disk files are never silently modified.
- **Overlay-Aware Reading**: `read_file` immediately reflects staged edits in memory before any write to disk.
- **Per-Hunk VS Code Diff Review**:
  - Uses built-in `vscode.diff` with custom URI schemes `forge-original:` and `forge-proposed:`.
  - CodeLens per hunk: `Accept hunk (Alt+Y) | Reject hunk (Alt+N) | Next (Alt+])`.
  - Hunks outside selection ranges are flagged with `outsideSelection`.
  - "Forge Review" tree view in the Explorer activity bar.
  - Atomic gated application with Undo records saved in `context.globalStorageUri`.
  - Revert changes via command: `Forge: Undo last applied change`.
- **Activity Bar Webview Panel ("Forge")**:
  - Strict nonce-based Content Security Policy (CSP).
  - 15px 1080p-legible typography.
  - `@ autocomplete` popup for files and symbols + visual context budget bar.
  - Batched streaming markdown transcript.
  - Prominent "Context chosen" table card (`File`, `Lines`, `Score`, `Why`, `Tokens`).
  - Tool approval banner (`Review changes`, `Allow`, `Deny`).
  - Model badge and Stop / New-Chat controls.
- **Inline Edit (`Ctrl+Alt+K`)**:
  - Select code or cursor position, press `Ctrl+Alt+K` (or `Cmd+Alt+K` on macOS) or right-click editor context menu.
  - Invokes `forge-inline` agent and routes staged edits directly into the shared per-hunk review UI.

### Task C: Clean Cancellation State Machine & Multi-Model Resilience
- **RunController State Machine**:
  `idle` -> `running` -> `paused-for-approval` -> `applying` -> `cancelling` -> `idle`
  - Stop button or `Esc` immediately aborts the local stream reader, calls `sessions.cancel` on TrueForge, discards the in-memory ChangeSet and overlays, closes open review tabs, and leaves workspace git status completely clean.
- **Resilience Error Classification**:
  Classifies failures across 6 categories:
  1. `AUTH`: 401/403 or invalid credentials -> immediate fallback.
  2. `UNREACHABLE`: Network dropped / connection refused -> retry then fallback.
  3. `RATE_LIMIT`: 429 quota exhaustion -> retry with exponential backoff then fallback.
  4. `SERVER`: 500/502/504 server error -> retry with backoff.
  5. `CONTEXT_TOO_LONG`: Context limit exceeded -> compaction / reduction.
  6. `SERVER_DOWN`: 503 unavailable -> retry then fallback.
- **Automatic Multi-Model Failover**:
  When primary model errors occur or retries are exhausted, the extension:
  1. Discards any partial staged changes (zero dirty files).
  2. Switches to next model in `config.models` (e.g. Gemini -> Groq custom provider).
  3. Shows non-modal banner: `Primary model failed... Switched to fallback: <model>`.
  4. Updates webview model badge.
  5. Re-executes the turn seamlessly on the fallback session.
- **Interactive Dev Commands**:
  - `Forge: Simulate primary failure`: Forces simulated primary error to verify automatic failover.
  - `Forge: Restore models`: Restores primary model and clears simulation flags.
  - `Forge: Review (demo fixture)`: Loads a sample multi-hunk diff into the review UI.

---

## 5. Verification Commands

```bash
# Verify compilation and bundle
npm run build

# Run complete test suite (anti-hang rule: under 5000ms timeout, zero live network calls)
npx vitest run --testTimeout=5000
```
