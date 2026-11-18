import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { isCommandAllowed, isPathAllowed } from './policy.js';
import { WorkspaceIndexer } from '../context/indexer.js';
import { packContext, BUDGET_CONSTANTS, estimateTokens } from '../context/budget.js';
import { EditToolsManager } from './tools/editTools.js';

export interface McpServerOptions {
  port?: number;
  host?: string;
  token: string;
  workspaceRoot: string;
  indexer?: WorkspaceIndexer;
  editTools?: EditToolsManager;
}

export class McpServer {
  private server: http.Server | null = null;
  private port: number;
  private host: string;
  private token: string;
  private workspaceRoot: string;
  private indexer: WorkspaceIndexer;
  private editTools?: EditToolsManager;
  // In-memory staged overlay hook: relative/resolved path -> content
  private stagedOverlay: Map<string, string> = new Map();

  constructor(options: McpServerOptions) {
    this.port = options.port ?? 8799;
    this.host = options.host ?? '127.0.0.1';
    this.token = options.token;
    this.workspaceRoot = path.normalize(options.workspaceRoot);
    this.indexer = options.indexer ?? new WorkspaceIndexer();
    if (options.editTools) {
      this.editTools = options.editTools;
      this.editTools.setOverlayUpdateCallback((p, c) => this.setStagedOverlay(p, c));
    }
  }

  public setEditTools(editTools: EditToolsManager): void {
    this.editTools = editTools;
    this.editTools.setOverlayUpdateCallback((p, c) => this.setStagedOverlay(p, c));
  }

  public getEditTools(): EditToolsManager | undefined {
    return this.editTools;
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  public getIndexer(): WorkspaceIndexer {
    return this.indexer;
  }

  public setStagedOverlay(filePath: string, content: string | null): void {
    const normalized = path.normalize(filePath);
    if (content === null) {
      this.stagedOverlay.delete(normalized);
    } else {
      this.stagedOverlay.set(normalized, content);
    }
  }

  public getStagedOverlay(filePath: string): string | undefined {
    const normalized = path.normalize(filePath);
    return this.stagedOverlay.get(normalized);
  }

  public isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  public getPort(): number {
    if (this.server && this.server.listening) {
      const addr = this.server.address();
      if (addr && typeof addr === 'object') {
        return addr.port;
      }
    }
    return this.port;
  }

  public start(port?: number, host?: string): Promise<number> {
    const listenPort = port ?? this.port;
    const listenHost = host ?? this.host;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(listenPort, listenHost, () => {
        const actualPort = this.getPort();
        this.port = actualPort;
        resolve(actualPort);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * HTTP request dispatcher with Bearer authentication.
   */
  public async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 1. Authenticate Authorization: Bearer <token>
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${this.token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized: invalid or missing Bearer token' },
        id: null
      }));
      return;
    }

    if (req.method === 'GET' && (req.url === '/mcp' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'forge-editor' }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32601, message: 'Method Not Allowed' },
        id: null
      }));
      return;
    }

    // Read POST body
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        const jsonRpc = JSON.parse(body);
        const result = await this.dispatchJsonRpc(jsonRpc);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: `Parse error: ${err.message}` },
          id: null
        }));
      }
    });
  }

  /**
   * Dispatches JSON-RPC 2.0 MCP methods.
   */
  public async dispatchJsonRpc(request: any): Promise<any> {
    const { id, method, params } = request;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: {
              name: 'forge-editor',
              version: '0.0.1'
            },
            capabilities: {
              tools: {}
            }
          }
        };

      case 'notifications/initialized':
        return { jsonrpc: '2.0', id: id ?? null, result: {} };

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: this.getToolDefinitions()
          }
        };

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        try {
          const content = await this.executeTool(toolName, toolArgs);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: typeof content === 'string' ? content : JSON.stringify(content, null, 2)
                }
              ]
            }
          };
        } catch (toolErr: any) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Tool execution failed: ${toolErr.message}`
                }
              ],
              isError: true
            }
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        };
    }
  }

  public getToolDefinitions(): any[] {
    const tools = [
      {
        name: 'repo_map',
        description: 'Generates a structural hierarchy tree of workspace files within a token budget.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Subdirectory path to map (defaults to workspace root)' },
            depth: { type: 'number', description: 'Maximum directory recursion depth' },
            max_tokens: { type: 'number', description: 'Token budget cap (defaults to 1500)' }
          }
        }
      },
      {
        name: 'search_workspace',
        description: 'Searches workspace text files by query with mode text, regex, path, or symbol.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term or pattern' },
            mode: { type: 'string', enum: ['text', 'regex', 'path', 'symbol'], description: 'Search mode' },
            glob: { type: 'string', description: 'Optional file glob pattern' },
            max_results: { type: 'number', description: 'Max matching results (defaults to 20)' },
            context_lines: { type: 'number', description: 'Surrounding context lines per match' }
          },
          required: ['query']
        }
      },
      {
        name: 'read_file',
        description: 'Reads line-numbered file content with 400-line cap, safety checks, and staged overlay.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path of file to read' },
            start_line: { type: 'number', description: '1-based starting line' },
            end_line: { type: 'number', description: '1-based ending line' }
          },
          required: ['path']
        }
      },
      {
        name: 'run_command',
        description: 'Runs approved commands (pytest/python/flask/git/ls/rg) with timeout and tailed output.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to execute' },
            cwd: { type: 'string', description: 'Working directory' },
            timeout_s: { type: 'number', description: 'Execution timeout in seconds (default 120)' }
          },
          required: ['command']
        }
      },
      {
        name: 'retrieve_context',
        description: 'BM25-ranked context retrieval with identifier splitting, symbol & path boosts, and companion linking.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            max_tokens: { type: 'number', description: 'Token budget cap (defaults to 6000)' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Optional candidate file paths' }
          },
          required: ['query']
        }
      }
    ];

    if (this.editTools) {
      tools.push(...this.editTools.getToolDefinitions());
    }

    return tools;
  }

  public async executeTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'repo_map':
        return await this.toolRepoMap(args);
      case 'search_workspace':
        return await this.toolSearchWorkspace(args);
      case 'read_file':
        return await this.toolReadFile(args);
      case 'run_command':
        return await this.toolRunCommand(args);
      case 'retrieve_context':
        return await this.toolRetrieveContext(args);
      case 'stage_edit':
        if (!this.editTools) throw new Error('Edit tools not configured on MCP server.');
        return await this.editTools.handleStageEdit(args);
      case 'unstage':
        if (!this.editTools) throw new Error('Edit tools not configured on MCP server.');
        return await this.editTools.handleUnstage(args);
      case 'show_staged':
        if (!this.editTools) throw new Error('Edit tools not configured on MCP server.');
        return await this.editTools.handleShowStaged();
      case 'apply_changes':
        if (!this.editTools) throw new Error('Edit tools not configured on MCP server.');
        return await this.editTools.handleApplyChanges(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // --- TOOL IMPLEMENTATIONS ---

  public async toolRepoMap(args: { path?: string; depth?: number; max_tokens?: number }): Promise<string> {
    const maxTokens = args.max_tokens ?? BUDGET_CONSTANTS.REPO_MAP_MAX_TOKENS;
    const targetDir = args.path
      ? path.resolve(this.workspaceRoot, args.path)
      : this.workspaceRoot;

    const ignored = new Set(['node_modules', '.git', '.demo', 'dist', '__pycache__', '.pytest_cache', '.venv']);
    const lines: string[] = [];
    let entryCount = 0;

    const walk = async (current: string, prefix: string, currentDepth: number) => {
      if (args.depth !== undefined && currentDepth > args.depth) return;

      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
        if (ignored.has(entry.name)) continue;

        const isDir = entry.isDirectory();
        const display = `${prefix}${entry.name}${isDir ? '/' : ''}`;
        lines.push(display);
        entryCount++;

        const currentTokens = estimateTokens(lines.join('\n'));
        if (currentTokens > maxTokens - 40) {
          lines.push(`[Tree truncated to stay within ${maxTokens} tokens. Total entries shown: ${entryCount}]`);
          return;
        }

        if (isDir) {
          await walk(path.join(current, entry.name), `${prefix}  `, currentDepth + 1);
        }
      }
    };

    const rootName = path.basename(targetDir);
    lines.push(`${rootName}/`);
    await walk(targetDir, '  ', 1);

    return lines.join('\n');
  }

  public async toolSearchWorkspace(args: {
    query: string;
    mode?: 'text' | 'regex' | 'path' | 'symbol';
    glob?: string;
    max_results?: number;
    context_lines?: number;
  }): Promise<any[]> {
    const query = args.query;
    if (!query) throw new Error("Argument 'query' is required.");

    const mode = args.mode ?? 'text';
    const maxResults = args.max_results ?? 20;
    const contextLines = args.context_lines ?? 1;

    // Symbol mode: search indexed symbols directly
    if (mode === 'symbol') {
      const syms = this.indexer.findSymbols(query);
      return syms.slice(0, maxResults).map(s => ({
        path: s.filePath,
        line: s.line,
        kind: s.kind,
        name: s.name,
        container: s.containerName
      }));
    }

    const results: any[] = [];
    const ignored = new Set(['node_modules', '.git', '.demo', 'dist', '__pycache__', '.pytest_cache', '.venv']);

    const searchDir = async (dir: string) => {
      if (results.length >= maxResults) return;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          await searchDir(fullPath);
        } else if (entry.isFile()) {
          if (args.glob && !relPath.includes(args.glob.replace(/\*/g, ''))) {
            continue;
          }

          if (mode === 'path') {
            if (relPath.toLowerCase().includes(query.toLowerCase())) {
              results.push({ path: relPath, match: relPath });
            }
          } else {
            // Text or Regex search in file content
            try {
              const content = await fs.promises.readFile(fullPath, 'utf8');
              const lines = content.split(/\r?\n/);

              let regex: RegExp;
              if (mode === 'regex') {
                regex = new RegExp(query, 'i');
              } else {
                regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
              }

              for (let i = 0; i < lines.length; i++) {
                if (results.length >= maxResults) break;
                if (regex.test(lines[i])) {
                  const startCtx = Math.max(0, i - contextLines);
                  const endCtx = Math.min(lines.length, i + contextLines + 1);
                  const context = lines.slice(startCtx, endCtx).join('\n');

                  results.push({
                    path: relPath,
                    line: i + 1,
                    match: lines[i].trim(),
                    context
                  });
                }
              }
            } catch {
              // Binary or unreadable file
            }
          }
        }
      }
    };

    await searchDir(this.workspaceRoot);
    return results;
  }

  public async toolReadFile(args: { path: string; start_line?: number; end_line?: number }): Promise<string> {
    const rawPath = args.path;
    const policy = isPathAllowed(rawPath, this.workspaceRoot);
    if (!policy.allowed || !policy.resolvedPath) {
      throw new Error(`Policy violation: ${policy.reason}`);
    }

    const resolved = policy.resolvedPath;

    // Check Staged Overlay Hook
    let content: string;
    const staged = this.getStagedOverlay(resolved) ?? this.getStagedOverlay(rawPath);
    if (staged !== undefined) {
      content = staged;
    } else {
      if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${rawPath}`);
      }
      content = await fs.promises.readFile(resolved, 'utf8');
    }

    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;

    const start = Math.max(1, args.start_line ?? 1);
    let end = args.end_line ?? totalLines;

    // 400-line cap
    const maxLines = 400;
    const requestedCount = end - start + 1;
    let continuationHint = '';

    if (requestedCount > maxLines) {
      const cappedEnd = start + maxLines - 1;
      continuationHint = `\n[Showing lines ${start}-${cappedEnd} of ${totalLines}. Call read_file with start_line=${cappedEnd + 1} to continue]`;
      end = cappedEnd;
    }

    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((line, idx) => {
      const lineNum = start + idx;
      return `${lineNum} | ${line}`;
    });

    return numbered.join('\n') + continuationHint;
  }

  public async toolRunCommand(args: { command: string; cwd?: string; timeout_s?: number }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    executionTimeMs: number;
  }> {
    const command = args.command;
    const policy = isCommandAllowed(command);
    if (!policy.allowed) {
      throw new Error(`Command blocked by security policy: ${policy.reason}`);
    }

    const timeoutSec = args.timeout_s ?? 120;
    const timeoutMs = timeoutSec * 1000;
    const cwd = args.cwd ? path.resolve(this.workspaceRoot, args.cwd) : this.workspaceRoot;

    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return new Promise((resolve, reject) => {
      const proc = spawn(command, {
        cwd,
        shell: true,
        signal: controller.signal
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      proc.on('error', err => {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          reject(new Error(`Command timed out after ${timeoutSec} seconds.`));
        } else {
          reject(err);
        }
      });

      proc.on('close', code => {
        clearTimeout(timer);
        const executionTimeMs = Date.now() - startTime;

        // Tail to 200 lines
        const tailLines = (text: string, max: number = 200) => {
          const l = text.split(/\r?\n/);
          if (l.length <= max) return text;
          return `[Truncated: showing last ${max} lines of output]\n` + l.slice(-max).join('\n');
        };

        resolve({
          exitCode: code ?? 0,
          stdout: tailLines(stdout),
          stderr: tailLines(stderr),
          executionTimeMs
        });
      });
    });
  }

  public async toolRetrieveContext(args: { query: string; max_tokens?: number; paths?: string[] }): Promise<{
    items: any[];
    packedCode: string;
    footer: string;
    usedTokens: number;
    maxTokens: number;
  }> {
    const query = args.query;
    if (!query) throw new Error("Argument 'query' is required.");

    const maxTokens = args.max_tokens ?? BUDGET_CONSTANTS.RETRIEVE_CONTEXT_MAX_TOKENS;
    const searchResults = this.indexer.search(query, 20, args.paths);
    const packed = packContext(searchResults, maxTokens);

    return {
      items: packed.items,
      packedCode: packed.packedCode,
      footer: packed.footer,
      usedTokens: packed.usedTokens,
      maxTokens: packed.maxTokens
    };
  }
}
