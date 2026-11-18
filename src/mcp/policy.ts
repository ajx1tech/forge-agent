import * as path from 'path';
import * as fs from 'fs';

export const ALLOWED_EXECUTABLES = new Set([
  'pytest',
  'python',
  'python3',
  'py',
  'flask',
  'git',
  'ls',
  'dir',
  'rg',
  'ripgrep'
]);

export interface CommandPolicyResult {
  allowed: boolean;
  executable?: string;
  reason?: string;
}

export interface PathPolicyResult {
  allowed: boolean;
  resolvedPath?: string;
  reason?: string;
}

/**
 * Validates command against policy allowlist: pytest/python/flask/git/ls/rg.
 * Disallows arbitrary shell chaining and unapproved binaries.
 */
export function isCommandAllowed(command: string): CommandPolicyResult {
  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    return { allowed: false, reason: 'Command is empty.' };
  }

  const trimmed = command.trim();

  // Disallow command chaining and subshell execution for security
  const dangerousPatterns = [
    /[;&|]{2}/,      // && or ||
    /[;&|]/,         // ; or & or |
    /`.*`/,          // backtick evaluation
    /\$\(.*\)/,      // subshell execution $(...)
    /[<>]/           // redirection operators
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `Command chaining and redirection operators are strictly forbidden for safety.`
      };
    }
  }

  // Extract the binary / executable token
  const tokens = trimmed.split(/\s+/);
  const rawExecutable = tokens[0];

  // Resolve binary name by stripping directory path and extensions (.exe, etc.)
  const baseName = path.basename(rawExecutable).toLowerCase().replace(/\.exe$/, '');

  if (ALLOWED_EXECUTABLES.has(baseName)) {
    return {
      allowed: true,
      executable: baseName
    };
  }

  return {
    allowed: false,
    reason: `Executable '${baseName}' is not permitted by policy. Allowed: ${Array.from(ALLOWED_EXECUTABLES).join(', ')}`
  };
}

/**
 * Validates file path:
 * 1. Blocks '..' directory traversal.
 * 2. Blocks access to '.env*' files.
 * 3. Blocks symlinks.
 * 4. Ensures path resides within workspaceRoot.
 */
export function isPathAllowed(targetPath: string, workspaceRoot: string): PathPolicyResult {
  if (!targetPath || typeof targetPath !== 'string') {
    return { allowed: false, reason: 'File path is required.' };
  }

  // 1. Check for literal '..' in path components
  const normalizedRaw = targetPath.replace(/\\/g, '/');
  const pathParts = normalizedRaw.split('/');
  if (pathParts.includes('..')) {
    return {
      allowed: false,
      reason: "Path traversal ('..') is strictly blocked."
    };
  }

  // Resolve full absolute path within workspace
  const resolved = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.normalize(path.join(workspaceRoot, targetPath));

  // Workspace boundary check
  const normalizedRoot = path.normalize(workspaceRoot);
  const rel = path.relative(normalizedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      allowed: false,
      reason: "Access outside of the workspace directory is strictly blocked."
    };
  }

  // 2. Block .env* files
  const filename = path.basename(resolved);
  if (/^\.env(\..+)?$/i.test(filename)) {
    return {
      allowed: false,
      reason: "Access to environment variable files (.env*) is strictly blocked."
    };
  }

  // 3. Block symlinks if the file exists
  try {
    if (fs.existsSync(resolved)) {
      const lstat = fs.lstatSync(resolved);
      if (lstat.isSymbolicLink()) {
        return {
          allowed: false,
          reason: "Symlink targets are strictly blocked for safety."
        };
      }
    }
  } catch (err: any) {
    // If permission or read error, allow caller to handle during file read
  }

  return {
    allowed: true,
    resolvedPath: resolved
  };
}
