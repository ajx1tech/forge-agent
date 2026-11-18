# Progress Log

## Step 3: Implemented TrueForge SDK client, Streamable HTTP MCP server, and Budgeted Context Engine
- Date: 2026-11-17
- Status: Completed
- Details:
  - Implemented `src/config.ts` with default configurations matching `trueforge.config.example.json` and strict model list validation.
  - Implemented `src/trueforge/serverManager.ts` providing ping diagnostics and doctor health checks across server reachability, model configuration, MCP connector registration, and context token budgets.
  - Implemented `src/trueforge/client.ts` wrapping `@truefoundry/trueforge-sdk` with `createSession`, `streamTurn` (yielding normalized events: turnCreated, textDelta, toolCall, toolResult, approvalRequired, threadCreated/Done, turnDone), streaming tool call delta merging, `cancel`, `resumeWithApprovals`, and token & cost logging to Output channel 'Forge'.
  - Implemented `src/trueforge/bootstrap.ts` generating/retrieving Bearer token in VS Code SecretStorage, registering remote Streamable HTTP connector 'forge-editor' at `http://127.0.0.1:8799/mcp`, upserting `agents/forge-agent.json` and `agents/forge-inline.json`, and registering `forge.doctor` and `forge.ping` commands.
  - Implemented `src/mcp/policy.ts` with strict command execution allowlist (`pytest`, `python`, `flask`, `git`, `ls`, `rg`), blocking command chaining, directory traversal (`..`), symlinks, and `.env*` files.
  - Implemented `src/mcp/server.ts` with HTTP JSON-RPC MCP server on `127.0.0.1:8799/mcp` authenticated via Bearer token, exposing `repo_map`, `search_workspace`, `read_file` (400-line cap + continuation hint + staged overlay hook), `run_command` (timeout + tail 200 lines), and `retrieve_context`.
  - Implemented offline Context Engine:
    - `src/context/symbols.ts`: snake_case, camelCase, PascalCase, and dotted identifier splitting and symbol extraction.
    - `src/context/bm25.ts`: offline BM25 index with symbol boost (3x) and path boost (2x).
    - `src/context/indexer.ts`: workspace chunk indexing, one-hop companion linking (`src/**/X.py` <-> `tests/test_X.py` <-> `docs/X.rst`), storing state in `context.globalStorageUri` without workspace pollution.
    - `src/context/budget.ts`: token budgeting with 1500-token repo map, 6000-token context retrieval, 8000-token turn cap, code packing, and budget footers.
    - `src/context/mentions.ts`: `@file` and `@symbol` mention parser and resolver.
  - Created `test/core-backend.test.ts` covering 25 offline unit tests verifying all modules in under 3 seconds without background server hangs.

## Step 2: Created Pallets Flask 3.1.3 demo setup script
- Date: 2026-11-17
- Status: Completed
- Details:
  - Created `scripts/setup-flask.ps1` to clone `pallets/flask` (tag `3.1.3`) into `.demo/flask`.
  - Added commit verification asserting HEAD starts with `22d92470`.
  - Configured virtual environment creation in `.demo/flask/.venv`.
  - Automated dependency installation (`pip`, `-e .`, `pytest`) and executed baseline CLI test verification (`pytest tests/test_cli.py -q`).

## Step 1: Configured TypeScript, esbuild, vitest, and extension scaffolding
- Date: 2026-11-17
- Status: Completed
- Details:
  - Configured strict TypeScript (`tsconfig.json`) and `package.json` for `forge-agent` (displayName 'Forge Agent').
  - Configured esbuild bundler (`esbuild.config.mjs`) targeting Node and externalizing `vscode`.
  - Configured test runner with `vitest.config.ts`.
  - Implemented `src/extension.ts` registering command `forge.hello` with information message and logging activation to Output channel 'Forge'.
  - Added unit test suite in `test/hello.test.ts` verifying default configuration settings.

## Step 0: Initialized BRIEF and workspace skeleton
- Date: 2026-11-17
- Status: Completed
- Details:
  - Created project brief (`docs/BRIEF.md`) outlining TrueFoundry Forge-a-thon guidelines and architecture.
  - Set up directory skeleton (`src/`, `agents/`, `scripts/`, `docs/`, `test/`).
  - Added repository files: `LICENSE`, `NOTICE.md`, `.gitignore`, and `trueforge.config.example.json`.
