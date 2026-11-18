# Forge Agent - Evaluation & Demo Commands

This guide provides concise, copy-pasteable commands to test and demonstrate all features of the Forge Agent extension.

---

## 1. Setup & Baseline Verification

### Clone & Build
```powershell
# From repository root
npm install
npm run build
npx vitest run --testTimeout=5000
```

### Pallets Flask 3.1.3 Demo Environment
```powershell
# 1. Setup target repository (.demo/flask) with venv and baseline pytest
.\scripts\setup-flask.ps1

# 2. Reset target repository to clean state at any time
.\scripts\demo-reset.ps1
```

---

## 2. VS Code Command Palette Commands (`Ctrl+Shift+P` / `Cmd+Shift+P`)

| Command | Title | Action / Purpose |
|---|---|---|
| `forge.hello` | `Forge: Hello` | Smoke test verifying extension activation |
| `forge.doctor` | `Forge: Doctor` | Health diagnostics (server reachability, models, MCP connector, token budget) |
| `forge.ping` | `Forge: Ping` | Ping latency to local TrueForge instance |
| `forge.reviewDemoFixture` | `Forge: Review (demo fixture)` | Loads a multi-hunk sample diff into the diff editor with inside/outside selection tags |
| `forge.review` | `Forge: Review Staged Changes` | Opens built-in `vscode.diff` for currently staged files |
| `forge.inlineEdit` | `Forge: Inline Edit` | Prompts input box for inline code modification on active editor selection |
| `forge.applyChanges` | `Forge: Apply Accepted Changes` | Gated atomic apply of all accepted hunks with UndoRecord creation |
| `forge.undoLastAppliedChange` | `Forge: Undo last applied change` | Reverts the last applied WorkspaceEdit using saved UndoRecord |
| `forge.simulatePrimaryFailure` | `Forge: Simulate primary failure` | Simulates primary model error (AUTH/429) to demonstrate automatic failover |
| `forge.restoreModels` | `Forge: Restore models` | Restores model fallback index to primary model |

---

## 3. Keyboard Shortcuts

- **`Ctrl+Alt+K`** (macOS: `Cmd+Alt+K`): Trigger **Forge Inline Edit** on current selection or line.
- **`Alt+Y`**: **Accept Hunk** in the active review diff editor.
- **`Alt+N`**: **Reject Hunk** in the active review diff editor.
- **`Alt+]`**: Navigate to **Next Hunk** in review.

---

## 4. Testing Core Workflows

### Testing Task A: Context Retrieval & Safe MCP Server
1. Open the **Forge** view in the Activity Bar.
2. In chat input, type `@cli` or `@app` to test the `@` autocomplete dropdown.
3. Ask: `"Where is Flask's CLI click command group defined?"`
4. Notice the **Context Chosen** table card rendered in the chat showing retrieved file paths, lines, BM25 scores, and token counts.

### Testing Task B: In-Memory Staging, Per-Hunk Diff Review & Undo
1. Run command `Forge: Review (demo fixture)`.
2. Built-in `vscode.diff` opens displaying `forge-original:src/example-fixture.ts` vs `forge-proposed:src/example-fixture.ts`.
3. In the diff editor:
   - Notice the CodeLenses above each hunk: `Accept hunk (Alt+Y) | Reject hunk (Alt+N) | Next (Alt+])`.
   - Notice the `[outside selection]` badge on hunks outside the target range.
4. Click `Accept hunk` on Hunk 0, `Reject hunk` on Hunk 1, and `Accept hunk` on Hunk 2.
5. In the "Forge Review" tree view (Explorer panel) or approval banner, click **Apply Accepted Changes**.
6. The accepted hunks are applied atomically to disk, and an UndoRecord is created in `context.globalStorageUri`.
7. Run `Forge: Undo last applied change` to immediately revert disk changes.

### Testing Task C: Clean Cancellation & Multi-Model Resilience
1. **Clean Cancellation**:
   - Send a prompt in the Forge chat panel.
   - Click the **⏹ Stop** button (or press `Esc`).
   - The RunController transitions: `running -> cancelling -> idle`.
   - Streaming reader stops immediately, `sessions.cancel` is called, any staged in-memory changes are discarded, diff tabs are closed, and workspace files remain completely clean.
2. **Automatic Multi-Model Fallback**:
   - Run command `Forge: Simulate primary failure`.
   - Send a prompt in the Forge chat panel.
   - Observe the non-modal banner: `Primary model failed... Switched to fallback: custom/<groq-model-id>`.
   - Observe the header model badge automatically update from Gemini to Groq.
   - The query completes on the secondary model with zero dirty files left behind on failure.
   - Run `Forge: Restore models` to reset to primary model.
