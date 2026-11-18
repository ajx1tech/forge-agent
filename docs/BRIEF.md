# TrueFoundry Forge-a-thon (Techfest IIT Bombay) - Project Brief

## Project Overview
This project is an AI-powered VS Code extension developed for the TrueFoundry Forge-a-thon at Techfest IIT Bombay.

## Architecture & Integration Rules
- **TrueForge Integration**:
  - Local TrueForge instance runs at `http://localhost:8790` (v0.185.1).
  - Extension communicates exclusively via `@truefoundry/trueforge-sdk`.
  - Direct calls to external AI APIs (e.g., Gemini, Groq) from extension code are strictly prohibited; all agent loops route through TrueForge.
- **MCP Server**:
  - Streamable HTTP MCP server on `127.0.0.1:8799/mcp` authenticated via Bearer token.
- **Safety & Workspace Modifications**:
  - Zero workspace writes except user-approved edits.
  - Staging via in-memory `ChangeSet`.
  - TrueForge tool approval flow.
  - Per-hunk diff review and inspection before applying changes.
  - Full Undo capability and clean cancel support.
  - Extension state stored securely in `context.globalStorageUri` without silent edits to target workspaces.
- **Security**:
  - Zero credential leaks: No API keys committed or hardcoded in configuration or source code.
