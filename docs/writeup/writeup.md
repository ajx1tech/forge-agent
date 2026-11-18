# 1. Team
- **Project**: Forge Agent (TrueForge VS Code Extension)
- **Competition**: TrueFoundry Forge-a-thon, Techfest IIT Bombay
- **Team**: Antigravity Engineering Team
- **Focus Areas**: Agent Resilience, TrueForge SDK Integration, Per-Hunk Diff UI, and Context Engineering

---

# 2. Starting point
- **Declared Fork Point**: `None - written from scratch`
- The entire extension architecture was conceived, designed, and implemented from a blank slate specifically for the TrueFoundry Forge-a-thon.
- We deliberately built our solution without relying on pre-existing generic extension templates or third-party agent wrappers. The extension integrates natively with `@truefoundry/trueforge-sdk` (v0.185.1) and adheres to a strict zero-silent-write safety model where no files are modified on disk until explicitly approved through a per-hunk VS Code review flow.

---

# 3. Architecture on TrueForge
The Forge Agent architecture is partitioned into four decoupled layers communicating over standard protocols:

```
+------------------------------------------------------------------------+
|                      VS Code Extension Host                             |
|  +---------------------------+       +-------------------------------+  |
|  | Activity Bar WebviewView  | <---> | ReviewController & CodeLens   |  |
|  | - Strict Nonce CSP        |       | - forge-original: vs proposed:|  |
|  | - 15px Legible Typography |       | - Per-Hunk CodeLens (Alt+Y/N/])|  |
|  | - Context Budget Bar      |       | - Atomic WorkspaceEdit & Undo |  |
|  +---------------------------+       +-------------------------------+  |
|                |                                    |                   |
|                v                                    v                   |
|  +---------------------------+       +-------------------------------+  |
|  | RunController (State Mach)|       | In-Memory ChangeSet           |  |
|  | - idle -> running ->      |       | - Zero silent disk writes     |  |
|  |   paused -> applying ->   | <---> | - Exact unique old_str match  |  |
|  |   cancelling -> idle      |       | - Overlay-aware read_file     |  |
|  +---------------------------+       +-------------------------------+  |
+----------------|------------------------------------|-------------------+
                 | (JSON-RPC HTTP Bearer)             |
                 v                                    v
+------------------------------------+   +--------------------------------+
| Local Streamable HTTP MCP Server   |   | TrueForge Core Local Gateway   |
| (127.0.0.1:8799/mcp)               |   | (http://localhost:8790)        |
| - Tools: repo_map, search, read,   |   | - Agent definitions registered |
|   run_command, retrieve_context,   |   | - Model routing (Gemini / Groq)|
|   stage_edit, unstage, apply       |   | - Tool approvals & compaction  |
+------------------------------------+   +--------------------------------+
```

### Key Architectural Highlights
1. **Zero Silent Disk Writes**: All agent modifications are staged into an in-memory `ChangeSet`. Tools like `read_file` read through an in-memory overlay hook, enabling the model to inspect its staged progress without modifying workspace files on disk.
2. **Gated Per-Hunk Review**: Applying changes requires approval and operates at the individual hunk level. Accepted hunks are committed in a single atomic `vscode.WorkspaceEdit`, while saving an `UndoRecord` in `context.globalStorageUri`.
3. **RunController State Machine**: Clean state machine (`idle -> running -> paused-for-approval -> applying -> cancelling -> idle`). Clicking Stop or pressing `Esc` immediately cancels the remote turn, clears the in-memory changeset and overlay, closes review diff tabs, and restores git status cleanly.
4. **Isolated HTTP MCP Server**: Runs as an authenticated Streamable HTTP server on `127.0.0.1:8799/mcp` protected by a UUID Bearer token stored in `vscode.SecretStorage`.

---

# 4. How context is selected
Forge Agent features a custom offline Context Engine designed for high relevance within strict token budgets:

1. **Identifier Splitting & Tokenization**: Code identifiers are split into sub-tokens across `snake_case`, `camelCase`, `PascalCase`, and `dotted.paths` (e.g. `get_user_by_id` -> `get`, `user`, `by`, `id`).
2. **Weighted BM25 Ranking**:
   - **Base Content**: 1x weight on token occurrences in chunk content.
   - **Symbol Boost**: 3x weight on declared function, class, and method names.
   - **Path Boost**: 2x weight on directory and file path components.
3. **One-Hop Companion Linking**: Automatically establishes bidirectional links between source code, tests, and documentation:
   `src/**/X.py` $\longleftrightarrow$ `tests/test_X.py` $\longleftrightarrow$ `docs/X.rst`
   When a source file matches a query, representative chunks from its companion test file are scored and bundled at a 75% affinity score.
4. **Token Budget Allocation**:
   - **Repo Map Budget**: Cap at 1,500 tokens for structural file tree hierarchy.
   - **Retrieved Context Budget**: Cap at 6,000 tokens for ranked snippets.
   - **Turn Cap**: Cap at 8,000 tokens per interaction with budget footers (`[Context Budget: 4200/8000 tokens (3800 remaining)]`).

---

# 5. Model setup
- **Primary Model**: `google-gemini/<primary-model-id>`
  - Utilized for the main conversational loop, multi-file architectural reasoning, and complex refactoring tasks.
- **Fallback / Inline Model**: `custom/<groq-model-id>`
  - Utilized for low-latency completions, fast inline edits (`Ctrl+Alt+K`), and as an automatic failover target.
- **Resilience & Automatic Failover (Task C)**:
  - Errors are categorized into 6 standard codes: `AUTH`, `UNREACHABLE`, `RATE_LIMIT`, `SERVER`, `CONTEXT_TOO_LONG`, and `SERVER_DOWN`.
  - Transient network and server errors are retried with exponential backoff.
  - On authentication errors, unreachable network, or exhausted retries, the `ModelFallbackManager` automatically:
    1. Clears partially staged changes (guaranteeing zero files modified on failure).
    2. Swaps to the next configured model in `config.models`.
    3. Displays a non-modal notification banner: `"Primary model failed... Switched to fallback: <model>"`.
    4. Updates the model badge in the Activity Bar webview.
    5. Re-executes the request seamlessly on a new session.

---

# 6. Scorecard
| Metric / Criteria | Result / Specification | Verification Method |
|---|---|---|
| **Zero Silent Disk Writes** | 100% Staged in Memory | Verified via `test/review-ui.test.ts` (disk content unaltered until `apply_changes`) |
| **Atomic Undo Capability** | Full Revert / Delete created | Reverts files and deletes newly created files using `UndoRecord` |
| **CRLF & Line Endings** | 100% Preserved | CRLF files maintain `\r\n` across accepted/rejected hunk combinations |
| **Test Execution Speed** | 2.74 seconds total | 54 tests run in parallel via Vitest, well under 5,000ms limit |
| **Network Safety in Tests** | Zero live network calls | Mock HTTP dispatcher and zero open background listening sockets |
| **Token Budget Compliance** | Strictly capped | 1500 repo-map, 6000 context, 8000 turn limit enforced |
| **Cancellation Cleanliness** | 100% Clean Git Status | `RunController.cancel()` closes diff tabs, clears overlay and changeset |

---

# 7. Tools used
The extension registers and provides 9 safe, budget-managed tools through the `forge-editor` MCP connector:

1. **`repo_map`**: Generates a structural workspace file tree within token bounds.
2. **`search_workspace`**: Fast text, regex, path, and symbol search with context lines.
3. **`read_file`**: Line-numbered reading with 400-line cap, continuation hints, and staged overlay hook.
4. **`run_command`**: Strictly allowlisted execution (`pytest`, `python`, `flask`, `git`, `ls`, `rg`) with timeout and tailed output.
5. **`retrieve_context`**: BM25-ranked snippet packing with symbol/path boosts and companion linking.
6. **`stage_edit`**: Stages string replacements or full content into the in-memory ChangeSet with line-numbered mismatch errors.
7. **`unstage`**: Removes staged files from memory and clears overlay hooks.
8. **`show_staged`**: Returns summary statistics of currently staged changes and hunks.
9. **`apply_changes`**: Gated operation to commit accepted hunks atomically via `vscode.WorkspaceEdit`.

### Frameworks & Libraries
- `@truefoundry/trueforge-sdk` (v0.185.1)
- `@types/vscode` (v1.90.0)
- TypeScript (v5.4.5) & esbuild (v0.21.4)
- Vitest (v1.6.0)

---

# 8. Known limitations
1. **Line-Based Diffing vs AST-Aware Hunks**:
   Diff hunks are computed at line boundaries using LCS line diffing. While line endings (CRLF/LF) and whitespace are strictly preserved, contiguous edits on adjacent lines are grouped into a single hunk. Future versions will incorporate language-aware Tree-sitter AST nodes to separate adjacent independent declarations into discrete hunks.
2. **Local vs Remote MCP Distribution**:
   The current MCP server listens on local loopback (`127.0.0.1:8799/mcp`). Deploying the MCP server across remote cloud devboxes requires establishing a secure TLS tunnel or Mutual TLS (mTLS) gateway.
3. **Symbol Extraction Scope**:
   Current heuristic symbol extraction focuses on Python, TypeScript, and JavaScript. Support for languages like Rust, Go, or C++ will be added through language server protocol (LSP) integrations.
