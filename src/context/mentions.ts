import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceIndexer } from './indexer.js';
import { SymbolInfo } from './symbols.js';
import { isPathAllowed } from '../mcp/policy.js';

export interface FileMention {
  type: 'file';
  raw: string;
  target: string;
  resolvedPath?: string;
  content?: string;
  found: boolean;
}

export interface SymbolMention {
  type: 'symbol';
  raw: string;
  target: string;
  symbols: SymbolInfo[];
  found: boolean;
}

export type Mention = FileMention | SymbolMention;

export interface ParsedMentions {
  files: string[];
  symbols: string[];
}

/**
 * Extracts @file and @symbol mentions from prompt text.
 * Supports:
 *   - @file:path/to/file or @file:"path with spaces" or @path/to/file.ext
 *   - @symbol:functionName or @symbol:"name" or @#symbolName
 */
export function parseMentions(text: string): ParsedMentions {
  const files: Set<string> = new Set();
  const symbols: Set<string> = new Set();
  if (!text) return { files: [], symbols: [] };

  // Explicit @file: patterns
  const fileRegex = /@file:(?:"([^"]+)"|'([^']+)'|([^\s,;]+))/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(text)) !== null) {
    const val = match[1] || match[2] || match[3];
    if (val) files.add(val.trim());
  }

  // Bare @path/to/file.ext patterns
  const bareFileRegex = /(?<=^|\s)@((?:[\w-]+\/)+[\w-]+\.[a-zA-Z0-9]+)(?=$|\s|[.,;:])/g;
  while ((match = bareFileRegex.exec(text)) !== null) {
    if (match[1]) files.add(match[1].trim());
  }

  // Explicit @symbol: patterns
  const symbolRegex = /@symbol:(?:"([^"]+)"|'([^']+)'|([^\s,;]+))/g;
  while ((match = symbolRegex.exec(text)) !== null) {
    const val = match[1] || match[2] || match[3];
    if (val) symbols.add(val.trim());
  }

  // Short syntax @#symbolName
  const hashSymbolRegex = /(?<=^|\s)@#([A-Za-z0-9_]+)(?=$|\s|[.,;:])/g;
  while ((match = hashSymbolRegex.exec(text)) !== null) {
    if (match[1]) symbols.add(match[1].trim());
  }

  return {
    files: Array.from(files),
    symbols: Array.from(symbols)
  };
}

/**
 * Resolves mentions against workspace files and symbol index.
 * Returns formatted context blocks ready to prepend to the turn prompt.
 */
export async function resolveMentions(
  text: string,
  indexer: WorkspaceIndexer,
  workspaceRoot: string
): Promise<{ mentions: Mention[]; contextSnippet: string }> {
  const { files, symbols } = parseMentions(text);
  const mentions: Mention[] = [];
  const contextSections: string[] = [];

  // Resolve @file mentions
  for (const f of files) {
    const policy = isPathAllowed(f, workspaceRoot);
    if (!policy.allowed || !policy.resolvedPath) {
      mentions.push({
        type: 'file',
        raw: `@file:${f}`,
        target: f,
        found: false
      });
      continue;
    }

    try {
      if (fs.existsSync(policy.resolvedPath)) {
        const content = await fs.promises.readFile(policy.resolvedPath, 'utf8');
        const lines = content.split(/\r?\n/);
        const excerpt = lines.slice(0, 100).join('\n');
        mentions.push({
          type: 'file',
          raw: `@file:${f}`,
          target: f,
          resolvedPath: policy.resolvedPath,
          content: excerpt,
          found: true
        });

        contextSections.push(
          `--- Mentioned File: ${f} ---\n${excerpt}${lines.length > 100 ? '\n... [truncated]' : ''}`
        );
      } else {
        mentions.push({
          type: 'file',
          raw: `@file:${f}`,
          target: f,
          found: false
        });
      }
    } catch {
      mentions.push({
        type: 'file',
        raw: `@file:${f}`,
        target: f,
        found: false
      });
    }
  }

  // Resolve @symbol mentions
  for (const s of symbols) {
    const foundSyms = indexer.findSymbols(s);
    if (foundSyms.length > 0) {
      mentions.push({
        type: 'symbol',
        raw: `@symbol:${s}`,
        target: s,
        symbols: foundSyms,
        found: true
      });

      const symLines = foundSyms.map(sym =>
        `  - ${sym.kind} ${sym.name} in ${sym.filePath}:${sym.line}`
      ).join('\n');
      contextSections.push(`--- Mentioned Symbol: ${s} ---\n${symLines}`);
    } else {
      mentions.push({
        type: 'symbol',
        raw: `@symbol:${s}`,
        target: s,
        symbols: [],
        found: false
      });
    }
  }

  const contextSnippet = contextSections.length > 0
    ? `[User Mentions Context]\n${contextSections.join('\n\n')}\n`
    : '';

  return {
    mentions,
    contextSnippet
  };
}
