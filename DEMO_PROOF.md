# Forge Agent — Verification & Demo Proof

**Team:** `illusory` (`TM-E1C05773261`)  
**Repository:** [https://github.com/ajx1tech/forge-agent](https://github.com/ajx1tech/forge-agent)  
**Target Workspace:** `pallets/flask@3.1.3` (`22d92470`)  
**Harness & MCP Endpoint:** TrueForge Local Server (`http://localhost:8790`) + `forge-editor` Streamable HTTP MCP (`http://127.0.0.1:8799/mcp`)

---

## Overview

This document provides end-to-end visual verification of **Forge Agent** executing against `pallets/flask@3.1.3` inside the VS Code Extension Development Host and the TrueForge local observability dashboard. Each snapshot below documents a core architectural capability:

1. **Task A — Selection-Scoped Inline Edit & Atomic Diff Review (`forge-inline`)**
2. **TrueForge Session Telemetry & MCP Tool Execution (`0 Errors`, `11 Tool Calls`)**
3. **Task B — Unprompted Multi-File Context Discovery (`retrieve_context` + `read_file`)**
4. **Task B — Agent Panel Execution & Flask CLI Test Environment Verification**
5. **Task C — Resilience, Automatic Failover to Groq, & Human-in-the-Loop Tool Approval Gate**

---

## 1. Task A: Inline Edit, Per-Hunk Diff Review, and Workspace Application

![Task A Inline Edit Diff Review](docs/demo-proof/01-task-a-inline-edit-diff.png)

### What This Snapshot Proves
* **Selection-Scoped Inline Edit (`forge-inline`):** Triggering **Forge: Inline Edit** on `get_debug_flag()` (`src/flask/helpers.py`, lines 28–33) with the instruction to treat `'off'` and `'n'` as `False` case-insensitively stages an atomic, in-memory changeset and opens the side-by-side **Forge Review** diff editor (`helpers.py: Staged Changes (Forge Review)`).
* **Surgical Diff Accuracy:** Both the docstring (listing `'0'`, `'false'`, `'no'`, `'off'`, and `'n'`) and the return expression (`{"0", "false", "no", "off", "n"}`) are updated cleanly without altering surrounding functions (`get_load_dotenv`, etc.).
* **Controlled Disk Persistence:** Bottom-right notifications confirm the full lifecycle (`Forge: Staged inline edits for helpers.py. Review hunks in the diff editor.` followed by `Forge: Successfully applied changes to 1 file(s).`), while `git status` in the activated `.venv` terminal confirms only `src/flask/helpers.py` was modified.

---

## 2. Task A: TrueForge Session Telemetry & MCP Tool Trace

![Task A TrueForge Session Trace](docs/demo-proof/02-task-a-trueforge-session.png)

### What This Snapshot Proves
* **Native TrueForge Harness Execution:** Inside TrueForge (`http://localhost:8790/sessions`, Session `01m7ynpe11dsr5dkb7s7q9fa98`), the `forge-inline` agent completes the turn with **0 errors** across **11 MCP tool calls** (`41K` tokens processed).
* **End-to-End MCP Round-Trip:** TrueForge communicates directly with the local `forge-editor` MCP server (`127.0.0.1:8799/mcp`) to inspect `src/flask/helpers.py` via `read_file`, stage the replacement via `stage_edit`, and verify the exact resulting lines (`28–35`).

---

## 3. Task B: Autonomous Context Retrieval (`retrieve_context` & `read_file`)

![Task B Autonomous Context Retrieval in TrueForge](docs/demo-proof/03-task-b-context-retrieval-session.png)

### What This Snapshot Proves
* **Zero-Filename Discovery:** Given the unprompted Task B specification (*"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as `***`..."*), `forge-agent` (Session `01m7yq61brbd9kdt0247t6asww`) autonomously queries `forge-editor` without any file paths provided by the user.
* **Budgeted Retrieval Pipeline:** The session trace captures 5 sequential MCP steps (`Listing tools · forge-editor` -> `retrieve_context` -> `read_file` -> `retrieve_context` -> `read_file`) under the `8,000`-token context budget (`16K` total session tokens).
* **Upstream Demand Spike Observation:** After completing context discovery, the primary cloud model (`google-gemini/gemini-3-1-flash-lite`) returned an upstream `503: This model is currently experiencing high demand` error—directly motivating the multi-provider failover demonstrated in Task C below.

---

## 4. Task B: Forge Agent Sidebar & Flask CLI Test Suite Verification

![Task B Forge Panel and Pytest Verification](docs/demo-proof/04-task-b-agent-panel-and-tests.png)

### What This Snapshot Proves
* **Sidebar Agent Workflow:** Shows the Task B prompt submitted inside the **Forge: Forge Agent** sidebar panel with the `0 / 8,000 tokens` context budget meter and clean editor workspace.
* **Integrated Verification Environment:** Demonstrates the activated Python virtual environment (`(.venv) PS D:\forge-agent\.demo\flask>`) running `pytest tests/test_cli.py -q` (`55 passed, 3 skipped in 0.73s`) alongside CLI invocation checks.

---

## 5. Task C: Simulated Primary Failure, Automatic Failover to Groq, & Tool Approval Gate

![Task C Automatic Failover and Tool Approval Gate](docs/demo-proof/05-task-c-resilience-failover-approval.png)

### What This Snapshot Proves
* **Deterministic Primary Failure Simulation:** Running **Forge: Simulate primary failure** triggers `Forge: Simulated primary model failure ENABLED. Next turn will trigger fallback.`
* **Automatic Multi-Provider Failover:** On the next turn, `RunController` classifies the primary `AUTH` failure, automatically switches the active model to **`groq/llama-3.3-70b-versatile`** (confirmed both in the bottom-right notification and the top-left green model badge), and completes the edit seamlessly.
* **Safety & Human-in-the-Loop Approval Gate:** Before any file is written to disk, execution pauses at the **`Tool Approval Required: apply_changes (tool)`** gate (`Review changes` / `Allow` / `Deny`) with `helpers.py: Staged Changes (Forge Review)` open for inspection, while `git status` confirms `nothing to commit, working tree clean`.

---

## Repository Screenshot Placement Guide

To render all embedded images on GitHub, place the five snapshots in `docs/demo-proof/` using the filenames below:

| Embedded Path in `DEMO_PROOF.md` | Corresponding Capture | Demonstrated Capability |
| :--- | :--- | :--- |
| `docs/demo-proof/01-task-a-inline-edit-diff.png` | VS Code `helpers.py` Forge Review diff + `git status` | Task A inline edit, atomic hunk diff, and disk application |
| `docs/demo-proof/02-task-a-trueforge-session.png` | TrueForge `forge-inline` session (`11 tool calls`, `0 errors`) | TrueForge session observability and MCP tool execution |
| `docs/demo-proof/03-task-b-context-retrieval-session.png` | TrueForge `forge-agent` session (`retrieve_context` + `read_file`) | Unprompted Task B context assembly and upstream `503` trace |
| `docs/demo-proof/04-task-b-agent-panel-and-tests.png` | Forge sidebar Task B prompt + `pytest tests/test_cli.py -q` | Sidebar agent composer and Flask CLI test runner (`55 passed`) |
| `docs/demo-proof/05-task-c-resilience-failover-approval.png` | Failover to `groq/llama-3.3-70b-versatile` + `Tool Approval Required` | Task C resilience, fallback routing, approval gate, and clean `git status` |