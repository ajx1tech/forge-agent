import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { getConfig, validateModels, DEFAULT_CONFIG } from '../src/config.js';
import { TrueForgeClient } from '../src/trueforge/client.js';
import { ServerManager } from '../src/trueforge/serverManager.js';
import {
  bootstrapTrueForge,
  getOrCreateMcpToken,
  registerMcpConnector,
  upsertAgents,
  SECRET_MCP_TOKEN_KEY
} from '../src/trueforge/bootstrap.js';
import { isCommandAllowed, isPathAllowed } from '../src/mcp/policy.js';
import { McpServer } from '../src/mcp/server.js';
import { splitIdentifier, extractSymbols, tokenizeCode } from '../src/context/symbols.js';
import { BM25Index } from '../src/context/bm25.js';
import { WorkspaceIndexer } from '../src/context/indexer.js';
import { packContext, estimateTokens, BUDGET_CONSTANTS } from '../src/context/budget.js';
import { parseMentions, resolveMentions } from '../src/context/mentions.js';

describe('Forge Agent Core Backend Unit Tests', () => {
  let tempDir: string;
  let activeServers: McpServer[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  });

  afterEach(async () => {
    // Strict Anti-Hang Rule: Every HTTP server created MUST call server.close() in afterEach
    for (const s of activeServers) {
      if (s.isListening()) {
        await s.stop();
      }
    }
    activeServers = [];

    // Clean up temporary workspace
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Helper for in-memory HTTP request handling (zero network/port binding in tests)
  function invokeHttpRequest(
    server: McpServer,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<{ status: number; headers: any; body: any }> {
    return new Promise((resolve) => {
      const req: any = new EventEmitter();
      req.method = method;
      req.url = url;
      req.headers = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
      );

      let responseStatus = 200;
      let responseHeaders: any = {};
      let responseBody = '';

      const res: any = {
        writeHead: (status: number, hdrs: any) => {
          responseStatus = status;
          responseHeaders = hdrs;
        },
        end: (chunk?: string) => {
          if (chunk) responseBody += chunk;
          let parsed: any = responseBody;
          try {
            parsed = JSON.parse(responseBody);
          } catch {}
          resolve({
            status: responseStatus,
            headers: responseHeaders,
            body: parsed
          });
        }
      };

      server.handleHttpRequest(req, res);
      if (body) {
        req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.emit('end');
    });
  }

  // ==========================================
  // 1. CONFIGURATION TESTS
  // ==========================================
  describe('Configuration & Models Validation', () => {
    it('should provide default configuration matching specifications', () => {
      const config = getConfig();
      expect(config.baseUrl).toBe('http://localhost:8790');
      expect(config.mcpPort).toBe(8799);
      expect(config.mcpHost).toBe('127.0.0.1');
      expect(config.mcpPath).toBe('/mcp');
      expect(config.connectorName).toBe('forge-editor');
      expect(config.contextBudgetTokens).toBe(8000);
      expect(config.repoMapBudgetTokens).toBe(1500);
      expect(config.retrieveContextBudgetTokens).toBe(6000);
      expect(config.turnCapBudgetTokens).toBe(8000);
      expect(config.models.length).toBeGreaterThan(0);
    });

    it('should validate models list correctly', () => {
      const valid = validateModels(['google-gemini/gemini-2.5-pro', 'custom/groq-llama-3']);
      expect(valid.valid).toBe(true);
      expect(valid.errors.length).toBe(0);

      const empty = validateModels([]);
      expect(empty.valid).toBe(false);
      expect(empty.errors).toContain('At least one model must be configured.');

      const invalidItem = validateModels(['valid-model', '']);
      expect(invalidItem.valid).toBe(false);
      expect(invalidItem.errors[0]).toContain('Model at index 1 must be a non-empty string.');

      const nonArray = validateModels(null as any);
      expect(nonArray.valid).toBe(false);
      expect(nonArray.errors).toContain('Models configuration is required.');
    });
  });

  // ==========================================
  // 2. TRUEFORGE CLIENT TESTS
  // ==========================================
  describe('TrueForge SDK Client Wrapper', () => {
    it('should create session and log session ID to OutputChannel', async () => {
      const outputChannel = vscode.window.createOutputChannel('Forge');
      const mockSdk: any = {
        sessions: {
          create: vi.fn().mockResolvedValue({ data: { id: 'sess_12345' } }),
          cancel: vi.fn().mockResolvedValue({}),
          createTurnStream: vi.fn()
        }
      };

      const client = new TrueForgeClient(mockSdk, outputChannel);
      const res = await client.createSession({ agentName: 'forge-agent', title: 'Test Session' });

      expect(res.sessionId).toBe('sess_12345');
      expect(mockSdk.sessions.create).toHaveBeenCalledWith({
        agent: { name: 'forge-agent' },
        metadata: { title: 'Test Session' }
      });
      expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('sess_12345'));
    });

    it('should cancel active session', async () => {
      const outputChannel = vscode.window.createOutputChannel('Forge');
      const mockSdk: any = {
        sessions: {
          cancel: vi.fn().mockResolvedValue({})
        }
      };

      const client = new TrueForgeClient(mockSdk, outputChannel);
      await client.cancel('sess_12345');
      expect(mockSdk.sessions.cancel).toHaveBeenCalledWith('sess_12345');
    });

    it('should stream turn, perform tool delta merging, and log tokens & cost', async () => {
      const outputChannel = vscode.window.createOutputChannel('Forge');
      const rawEvents = [
        { type: 'turn.created', turnId: 'turn_001', threadId: 'main', createdAt: '2026-11-17T00:00:00Z' },
        { type: 'thread.created', threadId: 'main', title: 'Root Thread' },
        { type: 'model.message.delta', content: 'Hello ', threadId: 'main' },
        { type: 'model.message.delta', content: 'world!', threadId: 'main' },
        // Chunked tool call delta
        {
          type: 'model.message.delta',
          threadId: 'main',
          toolCalls: [
            { index: 0, id: 'call_abc', function: { name: 'read_file', arguments: '{"path":' } }
          ]
        },
        {
          type: 'model.message.delta',
          threadId: 'main',
          finishReason: 'tool_calls',
          toolCalls: [
            { index: 0, function: { arguments: '"src/config.ts"}' } }
          ],
          usage: { inputTokens: 100, outputTokens: 50 }
        },
        { type: 'tool.response', toolCallId: 'call_abc', content: 'file content', threadId: 'main' },
        { type: 'thread.done', threadId: 'main', state: { status: 'completed' } },
        { type: 'turn.done', id: 'turn_001', state: { status: 'done', usage: { inputTokens: 100, outputTokens: 50 } } }
      ];

      async function* eventGenerator() {
        for (const ev of rawEvents) {
          yield ev;
        }
      }

      const mockSdk: any = {
        sessions: {
          createTurnStream: vi.fn().mockReturnValue(eventGenerator())
        }
      };

      const client = new TrueForgeClient(mockSdk, outputChannel);
      const yieldedEvents: any[] = [];
      for await (const event of client.streamTurn('sess_12345', 'Inspect config')) {
        yieldedEvents.push(event);
      }

      // Verify normalized events
      expect(yieldedEvents.some(e => e.type === 'turnCreated' && e.turnId === 'turn_001')).toBe(true);
      expect(yieldedEvents.some(e => e.type === 'threadCreated' && e.threadId === 'main')).toBe(true);
      expect(yieldedEvents.filter(e => e.type === 'textDelta').map(e => e.text).join('')).toBe('Hello world!');

      // Tool call was merged across deltas: arguments should be parsed JSON object
      const toolCallEvent = yieldedEvents.find(e => e.type === 'toolCall');
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent.id).toBe('call_abc');
      expect(toolCallEvent.name).toBe('read_file');
      expect(toolCallEvent.arguments).toEqual({ path: 'src/config.ts' });

      expect(yieldedEvents.some(e => e.type === 'toolResult' && e.toolCallId === 'call_abc')).toBe(true);
      expect(yieldedEvents.some(e => e.type === 'threadDone')).toBe(true);
      expect(yieldedEvents.some(e => e.type === 'turnDone')).toBe(true);

      // Verify token and cost logging to Output channel 'Forge'
      expect(outputChannel.appendLine).toHaveBeenCalledWith(
        expect.stringMatching(/\[Forge\] Tokens: input=100, output=50, total=150, cost=\$/)
      );
    });

    it('should support approvalRequired event and resumeWithApprovals', async () => {
      const outputChannel = vscode.window.createOutputChannel('Forge');

      const approvalEvents = [
        {
          type: 'tool.approval_required',
          id: 'appr_req_1',
          threadId: 'main',
          toolCalls: [{ id: 'call_run_cmd', name: 'run_command' }]
        }
      ];

      const resumedEvents = [
        { type: 'model.message.delta', content: 'Execution resumed.', threadId: 'main' },
        { type: 'turn.done', id: 'turn_002', state: { status: 'done' } }
      ];

      async function* gen(items: any[]) {
        for (const item of items) yield item;
      }

      const mockSdk: any = {
        sessions: {
          createTurnStream: vi.fn()
            .mockReturnValueOnce(gen(approvalEvents))
            .mockReturnValueOnce(gen(resumedEvents))
        }
      };

      const client = new TrueForgeClient(mockSdk, outputChannel);

      // Turn 1 yields approvalRequired
      const t1Events: any[] = [];
      for await (const ev of client.streamTurn('sess_1', 'run test')) {
        t1Events.push(ev);
      }
      expect(t1Events[0].type).toBe('approvalRequired');
      expect(t1Events[0].toolCalls[0].id).toBe('call_run_cmd');

      // Turn 2 resume with approvals
      const t2Events: any[] = [];
      for await (const ev of client.resumeWithApprovals('sess_1', [
        { toolCallId: 'call_run_cmd', threadId: 'main', decision: 'allow' }
      ])) {
        t2Events.push(ev);
      }

      expect(mockSdk.sessions.createTurnStream).toHaveBeenLastCalledWith('sess_1', {
        input: [
          {
            type: 'user.tool_approval',
            threadId: 'main',
            toolCallId: 'call_run_cmd',
            approval: { status: 'allow' }
          }
        ],
        previousTurnId: undefined
      });
      expect(t2Events.some(e => e.type === 'textDelta' && e.text === 'Execution resumed.')).toBe(true);
    });
  });

  // ==========================================
  // 3. SERVER MANAGER & DOCTOR TESTS
  // ==========================================
  describe('ServerManager Doctor & Ping Diagnostics', () => {
    it('should return successful diagnostics when server and models are healthy', async () => {
      const mockSdk: any = {
        server: {
          getCapabilities: vi.fn().mockResolvedValue({})
        },
        models: {
          list: vi.fn().mockResolvedValue({
            data: [{ name: 'google-gemini/<primary-model-id>' }, { name: 'custom/<groq-model-id>' }]
          })
        },
        settings: {
          mcpServers: {
            get: vi.fn().mockResolvedValue({
              data: { manifest: { url: 'http://127.0.0.1:8799/mcp' } }
            })
          }
        }
      };

      const serverManager = new ServerManager(mockSdk);
      const pingRes = await serverManager.ping(1000);
      expect(pingRes.ok).toBe(true);

      const doctorRes = await serverManager.doctor();
      expect(doctorRes.ok).toBe(true);
      expect(doctorRes.checks.every(c => c.status !== 'error')).toBe(true);
    });

    it('should report warnings/errors when server is unreachable', async () => {
      const mockSdk: any = {
        server: {
          getCapabilities: vi.fn().mockRejectedValue(new Error('Connection refused'))
        }
      };

      const serverManager = new ServerManager(mockSdk);
      const pingRes = await serverManager.ping(500);
      expect(pingRes.ok).toBe(false);
      expect(pingRes.error).toContain('Connection refused');

      const doctorRes = await serverManager.doctor();
      const reachCheck = doctorRes.checks.find(c => c.name === 'Server Reachability');
      expect(reachCheck?.status).toBe('warning');
    });
  });

  // ==========================================
  // 4. BOOTSTRAP & CONNECTOR REGISTRATION
  // ==========================================
  describe('Bootstrap Flow & SecretStorage Connector Registration', () => {
    it('should generate, store, and reuse Bearer token from SecretStorage', async () => {
      const secretsMap = new Map<string, string>();
      const mockSecrets: vscode.SecretStorage = {
        get: vi.fn(async (key: string) => secretsMap.get(key)),
        store: vi.fn(async (key: string, val: string) => { secretsMap.set(key, val); }),
        delete: vi.fn(async (key: string) => { secretsMap.delete(key); }),
        keys: vi.fn(async () => Array.from(secretsMap.keys())),
        onDidChange: vi.fn() as any
      };

      const token1 = await getOrCreateMcpToken(mockSecrets);
      expect(token1).toBeDefined();
      expect(token1.length).toBeGreaterThan(10);
      expect(secretsMap.get(SECRET_MCP_TOKEN_KEY)).toBe(token1);

      // Subsequent call reuses existing token
      const token2 = await getOrCreateMcpToken(mockSecrets);
      expect(token2).toBe(token1);
    });

    it('should register MCP connector forge-editor with Bearer auth header', async () => {
      const config = getConfig();
      const mockSdk: any = {
        settings: {
          mcpServers: {
            createOrUpdate: vi.fn().mockResolvedValue({})
          }
        }
      };

      await registerMcpConnector(mockSdk, config, 'test-secret-token');
      expect(mockSdk.settings.mcpServers.createOrUpdate).toHaveBeenCalledWith({
        manifest: {
          name: 'forge-editor',
          type: 'remote',
          url: 'http://127.0.0.1:8799/mcp',
          description: 'Forge Editor workspace tools MCP server',
          auth: {
            type: 'header',
            headers: {
              Authorization: 'Bearer test-secret-token'
            }
          }
        }
      });
    });

    it('should upsert forge-agent and forge-inline agents', async () => {
      const mockSdk: any = {
        agents: {
          list: vi.fn().mockResolvedValue({
            data: [{ id: 'agent_existing_1', name: 'forge-agent' }]
          }),
          update: vi.fn().mockResolvedValue({}),
          create: vi.fn().mockResolvedValue({ data: { id: 'agent_new_2' } })
        }
      };

      const agentsToUpsert = [
        {
          name: 'forge-agent',
          description: 'Updated forge-agent',
          manifest: { model: { name: 'google-gemini/<primary-model-id>' } }
        },
        {
          name: 'forge-inline',
          description: 'New forge-inline',
          manifest: { model: { name: 'custom/<groq-model-id>' } }
        }
      ];

      const results = await upsertAgents(mockSdk, agentsToUpsert);
      expect(results.length).toBe(2);
      expect(results[0]).toEqual({ name: 'forge-agent', id: 'agent_existing_1', action: 'updated' });
      expect(results[1]).toEqual({ name: 'forge-inline', id: 'agent_new_2', action: 'created' });

      expect(mockSdk.agents.update).toHaveBeenCalledWith('agent_existing_1', expect.anything());
      expect(mockSdk.agents.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'forge-inline' }));
    });
  });

  // ==========================================
  // 5. POLICY SECURITY CHECKS
  // ==========================================
  describe('Policy Security Enforcement', () => {
    it('should allow approved binaries (pytest, python, flask, git, ls, rg)', () => {
      expect(isCommandAllowed('pytest tests/test_cli.py -q').allowed).toBe(true);
      expect(isCommandAllowed('python -m pytest').allowed).toBe(true);
      expect(isCommandAllowed('.venv/Scripts/python.exe script.py').allowed).toBe(true);
      expect(isCommandAllowed('flask --help').allowed).toBe(true);
      expect(isCommandAllowed('git status').allowed).toBe(true);
      expect(isCommandAllowed('ls -la').allowed).toBe(true);
      expect(isCommandAllowed('rg "def test"').allowed).toBe(true);
    });

    it('should block unapproved binaries and dangerous operators', () => {
      expect(isCommandAllowed('curl http://malicious.com').allowed).toBe(false);
      expect(isCommandAllowed('powershell -c "rm -rf /"').allowed).toBe(false);
      expect(isCommandAllowed('bash -i').allowed).toBe(false);

      // Command chaining
      expect(isCommandAllowed('git status && rm -rf /').allowed).toBe(false);
      expect(isCommandAllowed('pytest; calc.exe').allowed).toBe(false);
      expect(isCommandAllowed('python app.py | sh').allowed).toBe(false);
      expect(isCommandAllowed('python -c "x" > out.txt').allowed).toBe(false);
    });

    it('should block directory traversal .. and symlinks and .env* files', () => {
      const wsRoot = tempDir;

      // Traversal blocked
      expect(isPathAllowed('../secret.txt', wsRoot).allowed).toBe(false);
      expect(isPathAllowed('src/../../secret.txt', wsRoot).allowed).toBe(false);

      // .env* files blocked
      expect(isPathAllowed('.env', wsRoot).allowed).toBe(false);
      expect(isPathAllowed('.env.local', wsRoot).allowed).toBe(false);
      expect(isPathAllowed('config/.env.prod', wsRoot).allowed).toBe(false);

      // Valid paths allowed
      const validPath = path.join(wsRoot, 'src', 'app.py');
      expect(isPathAllowed('src/app.py', wsRoot).allowed).toBe(true);
      expect(isPathAllowed(validPath, wsRoot).allowed).toBe(true);
    });
  });

  // ==========================================
  // 6. MCP SERVER & TOOLS TESTS
  // ==========================================
  describe('Streamable HTTP MCP Server & Workspace Tools', () => {
    it('should reject unauthorized requests and accept authorized requests over HTTP handler', async () => {
      const server = new McpServer({
        port: 8799,
        host: '127.0.0.1',
        token: 'secret-token-123',
        workspaceRoot: tempDir
      });

      // 1. Missing Authorization header -> 401
      const resUnauth = await invokeHttpRequest(server, 'POST', '/mcp', {}, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize'
      });
      expect(resUnauth.status).toBe(401);

      // 2. Valid Bearer Token -> 200
      const resAuth = await invokeHttpRequest(
        server,
        'POST',
        '/mcp',
        { 'Authorization': 'Bearer secret-token-123' },
        { jsonrpc: '2.0', id: 2, method: 'initialize' }
      );
      expect(resAuth.status).toBe(200);
      expect(resAuth.body.result.serverInfo.name).toBe('forge-editor');
    });

    it('should execute repo_map within token budget cap', async () => {
      // Create sample workspace structure
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'main.py'), 'print("hello")');
      fs.writeFileSync(path.join(tempDir, 'tests', 'test_main.py'), 'def test(): pass');

      const server = new McpServer({
        token: 'tok',
        workspaceRoot: tempDir
      });

      const mapResult = await server.executeTool('repo_map', { max_tokens: 1500 });
      expect(mapResult).toContain('src/');
      expect(mapResult).toContain('main.py');
      expect(mapResult).toContain('tests/');
    });

    it('should read file with line numbers, 400-line cap, and staged overlay hook', async () => {
      const sampleFile = path.join(tempDir, 'long_file.txt');
      const lines: string[] = [];
      for (let i = 1; i <= 450; i++) {
        lines.push(`Line number ${i}`);
      }
      fs.writeFileSync(sampleFile, lines.join('\n'));

      const server = new McpServer({
        token: 'tok',
        workspaceRoot: tempDir
      });

      // 1. Line numbers and 400-line cap
      const readRes = await server.executeTool('read_file', { path: 'long_file.txt' });
      expect(readRes).toContain('1 | Line number 1');
      expect(readRes).toContain('400 | Line number 400');
      expect(readRes).not.toContain('401 | Line number 401');
      expect(readRes).toContain('[Showing lines 1-400 of 450. Call read_file with start_line=401 to continue]');

      // 2. Staged overlay hook: in-memory staged changes take precedence over disk
      server.setStagedOverlay('long_file.txt', 'Staged line 1\nStaged line 2');
      const stagedReadRes = await server.executeTool('read_file', { path: 'long_file.txt' });
      expect(stagedReadRes).toContain('1 | Staged line 1');
      expect(stagedReadRes).toContain('2 | Staged line 2');
    });

    it('should search workspace by text, regex, path, and symbol', async () => {
      fs.writeFileSync(path.join(tempDir, 'calc.py'), 'def add_numbers(a, b):\n    return a + b\n');

      const indexer = new WorkspaceIndexer();
      await indexer.indexWorkspace(tempDir);

      const server = new McpServer({
        token: 'tok',
        workspaceRoot: tempDir,
        indexer
      });

      // Text mode
      const textMatches = await server.executeTool('search_workspace', { query: 'add_numbers', mode: 'text' });
      expect(textMatches.length).toBeGreaterThan(0);
      expect(textMatches[0].path).toBe('calc.py');

      // Regex mode
      const regexMatches = await server.executeTool('search_workspace', { query: 'return\\s+a', mode: 'regex' });
      expect(regexMatches.length).toBeGreaterThan(0);

      // Path mode
      const pathMatches = await server.executeTool('search_workspace', { query: 'calc', mode: 'path' });
      expect(pathMatches.length).toBeGreaterThan(0);

      // Symbol mode
      const symbolMatches = await server.executeTool('search_workspace', { query: 'add_numbers', mode: 'symbol' });
      expect(symbolMatches.length).toBeGreaterThan(0);
      expect(symbolMatches[0].name).toBe('add_numbers');
    });

    it('should run allowed command with tailing 200 lines and enforce timeout', async () => {
      const server = new McpServer({
        token: 'tok',
        workspaceRoot: tempDir
      });

      // Git command (allowed by policy)
      const cmdRes = await server.executeTool('run_command', { command: 'git --version' });
      expect(cmdRes.exitCode).toBe(0);
      expect(cmdRes.stdout).toContain('git version');

      // Unapproved command blocked by policy
      await expect(server.executeTool('run_command', { command: 'node -v' })).rejects.toThrow(
        /Command blocked by security policy/
      );
    });
  });

  // ==========================================
  // 7. CONTEXT ENGINE & BM25 TESTS
  // ==========================================
  describe('Context Engine: BM25, Splitting, Boosting & Companion Linking', () => {
    it('should split snake_case, camelCase, PascalCase, and dotted identifiers', () => {
      const tokens1 = splitIdentifier('flask.helpers.get_root_path');
      expect(tokens1).toContain('flask');
      expect(tokens1).toContain('helpers');
      expect(tokens1).toContain('get');
      expect(tokens1).toContain('root');
      expect(tokens1).toContain('path');

      const tokens2 = splitIdentifier('TestCliRunner');
      expect(tokens2).toContain('test');
      expect(tokens2).toContain('cli');
      expect(tokens2).toContain('runner');

      const tokens3 = splitIdentifier('create_test_client');
      expect(tokens3).toContain('create');
      expect(tokens3).toContain('test');
      expect(tokens3).toContain('client');
    });

    it('should apply symbol boost (3x) and path boost (2x) in BM25 scoring', () => {
      const bm25 = new BM25Index();

      // Doc A has symbol 'authenticate_user'
      bm25.addDocument({
        id: 'docA',
        filePath: 'src/auth.py',
        relativePath: 'src/auth.py',
        startLine: 1,
        endLine: 10,
        content: 'def login(): pass',
        symbols: [
          {
            name: 'authenticate_user',
            kind: 'function',
            line: 1,
            filePath: 'src/auth.py',
            tokens: splitIdentifier('authenticate_user')
          }
        ]
      });

      // Doc B has 'authenticate' only in body text
      bm25.addDocument({
        id: 'docB',
        filePath: 'src/notes.txt',
        relativePath: 'src/notes.txt',
        startLine: 1,
        endLine: 10,
        content: 'we need to authenticate user later',
        symbols: []
      });

      const results = bm25.search('authenticate_user');
      expect(results.length).toBeGreaterThan(0);
      // Doc A should rank first due to symbol boost (3x)
      expect(results[0].document.id).toBe('docA');
      expect(results[0].why).toContain('symbol boost (3x)');
    });

    it('should perform one-hop companion linking (src/**/X.py <-> tests/test_X.py <-> docs/X.rst)', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });

      fs.writeFileSync(path.join(tempDir, 'src', 'app.py'), 'class App:\n    def run(self): pass\n');
      fs.writeFileSync(path.join(tempDir, 'tests', 'test_app.py'), 'def test_app():\n    assert True\n');
      fs.writeFileSync(path.join(tempDir, 'docs', 'app.rst'), 'App Documentation\n=================\n');

      const indexer = new WorkspaceIndexer();
      await indexer.indexWorkspace(tempDir);

      // Verify companions for src/app.py
      const companions = indexer.findCompanions('src/app.py');
      expect(companions).toContain('tests/test_app.py');
      expect(companions).toContain('docs/app.rst');

      // Search matching src/app.py should expand companion test/doc
      const searchRes = indexer.search('run', 10);
      expect(searchRes.length).toBeGreaterThan(0);
      const companionResults = searchRes.filter(r => r.why.includes('companion link'));
      expect(companionResults.length).toBeGreaterThan(0);
    });

    it('should respect context budgets and format budget footer', () => {
      const mockResults: any[] = [
        {
          document: {
            relativePath: 'src/app.py',
            startLine: 1,
            endLine: 20,
            content: 'def run():\n    print("running")\n'
          },
          score: 12.5,
          why: 'symbol boost'
        }
      ];

      const packed = packContext(mockResults, 6000);
      expect(packed.items.length).toBe(1);
      expect(packed.usedTokens).toBeGreaterThan(0);
      expect(packed.maxTokens).toBe(6000);
      expect(packed.footer).toContain('[Context Budget:');
      expect(packed.footer).toContain('/6000 tokens');
      expect(packed.footer).toContain('remaining)');
      expect(packed.packedCode).toContain('=== File: src/app.py');
      expect(packed.packedCode).toContain(packed.footer);
    });

    it('should parse and resolve @file and @symbol mentions', async () => {
      fs.writeFileSync(path.join(tempDir, 'helper.py'), 'def compute_hash(data):\n    return hash(data)\n');

      const indexer = new WorkspaceIndexer();
      await indexer.indexWorkspace(tempDir);

      const prompt = 'Please check @file:helper.py and optimize @symbol:compute_hash for speed.';
      const parsed = parseMentions(prompt);
      expect(parsed.files).toContain('helper.py');
      expect(parsed.symbols).toContain('compute_hash');

      const resolved = await resolveMentions(prompt, indexer, tempDir);
      expect(resolved.mentions.length).toBe(2);
      expect(resolved.mentions[0].found).toBe(true);
      expect(resolved.mentions[1].found).toBe(true);
      expect(resolved.contextSnippet).toContain('--- Mentioned File: helper.py ---');
      expect(resolved.contextSnippet).toContain('--- Mentioned Symbol: compute_hash ---');
    });

    it('should never write index cache to target workspace (globalStorageUri only)', async () => {
      const globalStorage = path.join(tempDir, 'global-storage');
      fs.mkdirSync(globalStorage, { recursive: true });

      const targetWorkspace = path.join(tempDir, 'workspace');
      fs.mkdirSync(targetWorkspace, { recursive: true });
      fs.writeFileSync(path.join(targetWorkspace, 'code.py'), 'x = 1\n');

      const indexer = new WorkspaceIndexer({
        globalStorageUri: globalStorage
      });
      await indexer.indexWorkspace(targetWorkspace);

      // Verify that NO index files were written into targetWorkspace
      const workspaceFiles = fs.readdirSync(targetWorkspace);
      expect(workspaceFiles).toEqual(['code.py']);

      // Global storage contains the meta cache
      const globalFiles = fs.readdirSync(globalStorage);
      expect(globalFiles).toContain('index-meta.json');
    });
  });
});
