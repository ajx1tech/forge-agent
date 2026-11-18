import * as path from 'path';

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type';
  line: number;
  filePath: string;
  containerName?: string;
  tokens: string[];
}

/**
 * Splits identifiers across snake_case, camelCase, PascalCase, and dotted notations.
 * Example: 'flask.helpers.get_root_path' -> ['flask.helpers.get_root_path', 'flask', 'helpers', 'get_root_path', 'get', 'root', 'path']
 */
export function splitIdentifier(identifier: string): string[] {
  if (!identifier || typeof identifier !== 'string') return [];

  const rawLower = identifier.toLowerCase();
  const tokens = new Set<string>();
  tokens.add(rawLower);

  // Split on dots, slashes, hyphens, and underscores first
  const dotParts = identifier.split(/[\.\/\\_-]+/);
  for (const part of dotParts) {
    if (!part) continue;
    tokens.add(part.toLowerCase());

    // Split camelCase and PascalCase: e.g. 'TestCliRunner' -> ['Test', 'Cli', 'Runner']
    const camelParts = part.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/);

    for (const c of camelParts) {
      if (c && c.length > 0) {
        tokens.add(c.toLowerCase());
      }
    }
  }

  return Array.from(tokens);
}

/**
 * Tokenizes arbitrary code into a flat array of normalized search terms.
 */
export function tokenizeCode(text: string): string[] {
  if (!text) return [];
  const words = text.match(/[A-Za-z0-9_\.]+/g) || [];
  const allTokens: string[] = [];

  for (const w of words) {
    const subtokens = splitIdentifier(w);
    for (const t of subtokens) {
      if (t.length > 1) {
        allTokens.push(t);
      }
    }
  }

  return allTokens;
}

/**
 * Extracts declared symbols from Python and JavaScript/TypeScript code.
 */
export function extractSymbols(content: string, filePath: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const lines = content.split(/\r?\n/);
  const ext = path.extname(filePath).toLowerCase();

  let currentClass: string | undefined;
  let currentClassIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }

    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // Reset currentClass if indent is less than class definition
    if (currentClass && indent <= currentClassIndent) {
      currentClass = undefined;
      currentClassIndent = -1;
    }

    if (ext === '.py') {
      // Python Class
      const classMatch = line.match(/^\s*class\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        currentClass = classMatch[1];
        currentClassIndent = indent;
        symbols.push({
          name: currentClass,
          kind: 'class',
          line: lineNum,
          filePath,
          tokens: splitIdentifier(currentClass)
        });
        continue;
      }

      // Python Function or Method
      const defMatch = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/);
      if (defMatch) {
        const name = defMatch[1];
        const kind = currentClass ? 'method' : 'function';
        symbols.push({
          name,
          kind,
          line: lineNum,
          filePath,
          containerName: currentClass,
          tokens: splitIdentifier(name)
        });
        continue;
      }

      // Python top-level constant
      const constMatch = line.match(/^([A-Z0-9_]{2,})\s*=/);
      if (constMatch) {
        const name = constMatch[1];
        symbols.push({
          name,
          kind: 'variable',
          line: lineNum,
          filePath,
          tokens: splitIdentifier(name)
        });
        continue;
      }
    } else {
      // TypeScript / JavaScript
      const classMatch = line.match(/(?:export\s+)?class\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        currentClass = classMatch[1];
        currentClassIndent = indent;
        symbols.push({
          name: currentClass,
          kind: 'class',
          line: lineNum,
          filePath,
          tokens: splitIdentifier(currentClass)
        });
        continue;
      }

      const ifaceMatch = line.match(/(?:export\s+)?interface\s+([A-Za-z0-9_]+)/);
      if (ifaceMatch) {
        symbols.push({
          name: ifaceMatch[1],
          kind: 'interface',
          line: lineNum,
          filePath,
          tokens: splitIdentifier(ifaceMatch[1])
        });
        continue;
      }

      const typeMatch = line.match(/(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=/);
      if (typeMatch) {
        symbols.push({
          name: typeMatch[1],
          kind: 'type',
          line: lineNum,
          filePath,
          tokens: splitIdentifier(typeMatch[1])
        });
        continue;
      }

      const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
      if (funcMatch) {
        symbols.push({
          name: funcMatch[1],
          kind: 'function',
          line: lineNum,
          filePath,
          containerName: currentClass,
          tokens: splitIdentifier(funcMatch[1])
        });
        continue;
      }

      const constFuncMatch = line.match(/(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/);
      if (constFuncMatch) {
        symbols.push({
          name: constFuncMatch[1],
          kind: 'function',
          line: lineNum,
          filePath,
          tokens: splitIdentifier(constFuncMatch[1])
        });
        continue;
      }
    }
  }

  return symbols;
}
