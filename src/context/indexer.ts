import * as fs from 'fs';
import * as path from 'path';
import { BM25Index, IndexedDocument, BM25SearchResult } from './bm25.js';
import { extractSymbols, SymbolInfo } from './symbols.js';

export interface IndexerOptions {
  globalStorageUri?: { fsPath: string } | string;
  chunkSizeLines?: number;
  chunkOverlapLines?: number;
}

export class WorkspaceIndexer {
  private bm25: BM25Index;
  private allSymbols: SymbolInfo[] = [];
  private symbolsByName: Map<string, SymbolInfo[]> = new Map();
  private relativePathSet: Set<string> = new Set();
  private workspaceRoot: string = '';
  private globalStorageDir?: string;
  private isIndexed: boolean = false;

  constructor(options?: IndexerOptions) {
    this.bm25 = new BM25Index();
    if (options?.globalStorageUri) {
      this.globalStorageDir = typeof options.globalStorageUri === 'string'
        ? options.globalStorageUri
        : options.globalStorageUri.fsPath;
    }
  }

  public getBM25Index(): BM25Index {
    return this.bm25;
  }

  public getAllDocuments(): IndexedDocument[] {
    return this.bm25.getAllDocuments();
  }

  public getRelativePaths(): string[] {
    return Array.from(this.relativePathSet);
  }

  public getAllSymbols(): SymbolInfo[] {
    return this.allSymbols;
  }

  public findSymbols(name: string): SymbolInfo[] {
    const lower = name.toLowerCase();
    const exact = this.symbolsByName.get(lower);
    if (exact && exact.length > 0) return exact;

    // Substring match
    const matches: SymbolInfo[] = [];
    for (const [k, syms] of this.symbolsByName.entries()) {
      if (k.includes(lower)) {
        matches.push(...syms);
      }
    }
    return matches;
  }

  /**
   * One-hop test/doc companion linking:
   * src/** /X.py <-> tests/test_X.py <-> docs/X.rst
   */
  public findCompanions(relPath: string): string[] {
    const normalized = relPath.replace(/\\/g, '/');
    const companions: string[] = [];

    // Extract core name X
    let coreName: string | undefined;

    // Pattern 1: test file (e.g. tests/test_X.py or test/X.test.ts)
    const testMatch1 = normalized.match(/(?:^|\/)tests?\/test_([^\/]+)\.py$/);
    const testMatch2 = normalized.match(/(?:^|\/)tests?\/([^\/]+)\.test\.(?:ts|js)$/);
    const docMatch = normalized.match(/(?:^|\/)docs\/([^\/]+)\.(?:rst|md)$/);
    const srcMatch = normalized.match(/(?:^|\/)(?:src\/|flask\/)?([^\/]+)\.(?:py|ts|js)$/);

    if (testMatch1) {
      coreName = testMatch1[1];
    } else if (testMatch2) {
      coreName = testMatch2[1];
    } else if (docMatch) {
      coreName = docMatch[1];
    } else if (srcMatch) {
      coreName = srcMatch[1];
    }

    if (!coreName) return companions;

    // Potential candidates
    const candidates = [
      `src/${coreName}.py`,
      `src/${coreName}.ts`,
      `flask/${coreName}.py`,
      `${coreName}.py`,
      `tests/test_${coreName}.py`,
      `test/test_${coreName}.py`,
      `test/${coreName}.test.ts`,
      `docs/${coreName}.rst`,
      `docs/${coreName}.md`
    ];

    for (const candidate of candidates) {
      if (candidate.toLowerCase() !== normalized.toLowerCase()) {
        for (const existing of this.relativePathSet) {
          if (
            existing.toLowerCase() === candidate.toLowerCase() ||
            existing.toLowerCase().endsWith(`/${candidate.toLowerCase()}`)
          ) {
            if (!companions.includes(existing)) {
              companions.push(existing);
            }
          }
        }
      }
    }

    return companions;
  }

  public async indexWorkspace(workspaceRoot: string): Promise<number> {
    this.workspaceRoot = workspaceRoot;
    this.bm25.clear();
    this.allSymbols = [];
    this.symbolsByName.clear();
    this.relativePathSet.clear();

    const files = await this.collectFiles(workspaceRoot);
    for (const f of files) {
      this.relativePathSet.add(f.relPath);
    }

    let indexedChunks = 0;
    for (const file of files) {
      const chunks = this.chunkFile(file.fullPath, file.relPath, file.content);
      for (const chunk of chunks) {
        chunk.companionPaths = this.findCompanions(file.relPath);
        this.bm25.addDocument(chunk);
        indexedChunks++;
      }
    }

    this.isIndexed = true;

    // Save to globalStorage if configured (NEVER write to workspace!)
    await this.persistIndex();

    return indexedChunks;
  }

  public search(query: string, limit: number = 20, paths?: string[]): BM25SearchResult[] {
    const allowed = paths && paths.length > 0 ? new Set(paths.map(p => p.replace(/\\/g, '/'))) : undefined;
    const directResults = this.bm25.search(query, limit, allowed);

    // Expand one-hop companions
    const resultsMap = new Map<string, BM25SearchResult>();
    for (const res of directResults) {
      resultsMap.set(res.document.id, res);

      if (res.document.companionPaths && res.document.companionPaths.length > 0) {
        for (const compRelPath of res.document.companionPaths) {
          // Find chunks for companion
          for (const doc of this.bm25.getAllDocuments()) {
            if (doc.relativePath === compRelPath && !resultsMap.has(doc.id)) {
              resultsMap.set(doc.id, {
                document: doc,
                score: Number((res.score * 0.75).toFixed(4)), // 75% companion link score
                why: `one-hop companion link from ${res.document.relativePath}`
              });
              break; // add representative chunk
            }
          }
        }
      }
    }

    const merged = Array.from(resultsMap.values());
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, limit);
  }

  private chunkFile(fullPath: string, relPath: string, content: string): IndexedDocument[] {
    const lines = content.split(/\r?\n/);
    const symbols = extractSymbols(content, relPath);

    // Record symbols in catalog
    for (const s of symbols) {
      this.allSymbols.push(s);
      const lower = s.name.toLowerCase();
      const list = this.symbolsByName.get(lower) || [];
      list.push(s);
      this.symbolsByName.set(lower, list);
    }

    // Chunking: 50 lines with 10 lines overlap
    const chunkSize = 50;
    const overlap = 10;
    const chunks: IndexedDocument[] = [];

    if (lines.length <= chunkSize) {
      chunks.push({
        id: `${relPath}#L1-L${lines.length}`,
        filePath: fullPath,
        relativePath: relPath,
        startLine: 1,
        endLine: lines.length,
        content,
        symbols
      });
      return chunks;
    }

    for (let i = 0; i < lines.length; i += (chunkSize - overlap)) {
      const chunkLines = lines.slice(i, i + chunkSize);
      const startLine = i + 1;
      const endLine = i + chunkLines.length;

      // Filter symbols belonging to this chunk
      const chunkSymbols = symbols.filter(s => s.line >= startLine && s.line <= endLine);

      chunks.push({
        id: `${relPath}#L${startLine}-L${endLine}`,
        filePath: fullPath,
        relativePath: relPath,
        startLine,
        endLine,
        content: chunkLines.join('\n'),
        symbols: chunkSymbols
      });

      if (endLine >= lines.length) break;
    }

    return chunks;
  }

  private async collectFiles(dir: string, baseDir: string = dir): Promise<Array<{ fullPath: string; relPath: string; content: string }>> {
    const results: Array<{ fullPath: string; relPath: string; content: string }> = [];
    const ignoredDirs = new Set(['node_modules', '.git', '.demo', 'dist', '__pycache__', '.pytest_cache', '.venv']);

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name) && !entry.name.startsWith('.')) {
          results.push(...await this.collectFiles(fullPath, baseDir));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // Support code and documentation files
        if (['.py', '.ts', '.js', '.json', '.rst', '.md', '.txt'].includes(ext)) {
          const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          try {
            const content = await fs.promises.readFile(fullPath, 'utf8');
            results.push({ fullPath, relPath, content });
          } catch {
            // Ignore unreadable files
          }
        }
      }
    }

    return results;
  }

  private async persistIndex(): Promise<void> {
    if (!this.globalStorageDir) return;
    try {
      await fs.promises.mkdir(this.globalStorageDir, { recursive: true });
      const cachePath = path.join(this.globalStorageDir, 'index-meta.json');
      const meta = {
        workspaceRoot: this.workspaceRoot,
        totalSymbols: this.allSymbols.length,
        totalDocs: this.bm25.getAllDocuments().length,
        timestamp: new Date().toISOString()
      };
      await fs.promises.writeFile(cachePath, JSON.stringify(meta, null, 2), 'utf8');
    } catch {
      // Storage failure must not crash indexer
    }
  }
}
