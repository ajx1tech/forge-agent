import * as fs from 'fs';
import * as path from 'path';
import { DiffHunk, computeHunks, applyHunks, TargetRange } from './hunks.js';

export interface StagedFileChange {
  path: string; // normalized relative path
  fullPath: string;
  originalContent: string;
  proposedContent: string;
  hunks: DiffHunk[];
  isNewFile: boolean;
  rationale?: string;
  targetRange?: TargetRange;
}

export interface StageEditInput {
  old_str: string;
  new_str: string;
}

export interface StageOptions {
  create?: boolean;
  rationale?: string;
  targetRange?: TargetRange;
  originalContent?: string;
}

export class ChangeSet {
  private workspaceRoot: string;
  private stagedFiles: Map<string, StagedFileChange> = new Map();
  private listeners: Array<() => void> = [];

  constructor(workspaceRoot: string = process.cwd()) {
    this.workspaceRoot = path.normalize(workspaceRoot);
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  public onDidChange(listener: () => void): { dispose: () => void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(listener);
        if (idx >= 0) this.listeners.splice(idx, 1);
      }
    };
  }

  private notifyChange(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (e) {
        console.error('[ChangeSet] Listener error:', e);
      }
    }
  }

  public normalizePath(filePath: string): { relPath: string; fullPath: string } {
    const resolved = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.normalize(path.resolve(this.workspaceRoot, filePath));
    const relPath = path.relative(this.workspaceRoot, resolved).replace(/\\/g, '/');
    return { relPath, fullPath: resolved };
  }

  public hasStaged(): boolean {
    return this.stagedFiles.size > 0;
  }

  public getStaged(filePath: string): StagedFileChange | undefined {
    const { relPath } = this.normalizePath(filePath);
    return this.stagedFiles.get(relPath);
  }

  public getAllStaged(): StagedFileChange[] {
    return Array.from(this.stagedFiles.values());
  }

  /**
   * Reads original content from disk or existing staged change.
   */
  private getOriginalContent(fullPath: string, isCreate: boolean): string {
    if (isCreate) return '';
    if (fs.existsSync(fullPath)) {
      try {
        return fs.readFileSync(fullPath, 'utf8');
      } catch (err: any) {
        throw new Error(`Failed to read file '${fullPath}': ${err.message}`);
      }
    }
    return '';
  }

  /**
   * Helper to format line-numbered mismatch errors.
   */
  private formatLineNumberedContent(content: string, maxLines: number = 60): string {
    const lines = content.split(/\r?\n/);
    const slice = lines.slice(0, maxLines);
    const numbered = slice.map((line, idx) => `${idx + 1} | ${line}`).join('\n');
    return lines.length > maxLines
      ? `${numbered}\n... [${lines.length - maxLines} more lines]`
      : numbered;
  }

  /**
   * Finds occurrences of needle in haystack with exact match or line ending normalization.
   */
  private findOccurrences(haystack: string, needle: string): { index: number; line: number }[] {
    const results: { index: number; line: number }[] = [];
    if (!needle) return results;

    let searchNeedle = needle;
    let searchHaystack = haystack;

    // Direct match check
    let idx = searchHaystack.indexOf(searchNeedle);
    if (idx === -1) {
      // Try normalized \n matching
      const normHaystack = haystack.replace(/\r\n/g, '\n');
      const normNeedle = needle.replace(/\r\n/g, '\n');
      let normIdx = normHaystack.indexOf(normNeedle);
      while (normIdx !== -1) {
        // Calculate line number
        const line = normHaystack.slice(0, normIdx).split('\n').length;
        results.push({ index: normIdx, line });
        normIdx = normHaystack.indexOf(normNeedle, normIdx + 1);
      }
      return results;
    }

    while (idx !== -1) {
      const line = haystack.slice(0, idx).split(/\r?\n/).length;
      results.push({ index: idx, line });
      idx = haystack.indexOf(needle, idx + 1);
    }

    return results;
  }

  /**
   * Stages string replacement edits for a file into the in-memory ChangeSet.
   */
  public stageEdits(
    filePath: string,
    edits: StageEditInput[],
    options?: StageOptions
  ): StagedFileChange {
    const { relPath, fullPath } = this.normalizePath(filePath);
    const isNew = Boolean(options?.create);

    let originalContent: string;
    let currentContent: string;

    const existing = this.stagedFiles.get(relPath);
    if (existing) {
      originalContent = existing.originalContent;
      currentContent = existing.proposedContent;
    } else {
      if (options?.originalContent !== undefined) {
        originalContent = options.originalContent;
      } else {
        if (!isNew && !fs.existsSync(fullPath)) {
          throw new Error(`File does not exist: '${relPath}'. Pass create: true to create a new file.`);
        }
        originalContent = this.getOriginalContent(fullPath, isNew);
      }
      currentContent = originalContent;
    }

    // Apply each replacement sequentially
    for (let i = 0; i < edits.length; i++) {
      const { old_str, new_str } = edits[i];

      // Exact unique search
      const occurrences = this.findOccurrences(currentContent, old_str);

      if (occurrences.length === 0) {
        const sample = this.formatLineNumberedContent(currentContent);
        throw new Error(
          `Mismatch error: old_str not found in '${relPath}'.\n` +
          `Search text (edit index ${i}):\n${old_str}\n\n` +
          `Current file content with line numbers:\n${sample}`
        );
      }

      if (occurrences.length > 1) {
        const linesStr = occurrences.map(o => `line ${o.line}`).join(', ');
        throw new Error(
          `Mismatch error: old_str matches ${occurrences.length} times in '${relPath}' (found at ${linesStr}). ` +
          `Match must be unique. Provide more surrounding context lines.`
        );
      }

      // Unique match found: replace it
      // Handle both direct and CRLF-normalized replacement
      if (currentContent.includes(old_str)) {
        currentContent = currentContent.replace(old_str, new_str);
      } else {
        const normHaystack = currentContent.replace(/\r\n/g, '\n');
        const normNeedle = old_str.replace(/\r\n/g, '\n');
        const normReplacement = new_str.replace(/\r\n/g, '\n');
        const replacedNorm = normHaystack.replace(normNeedle, normReplacement);
        // Preserve original CRLF if haystack had it
        const eol = currentContent.includes('\r\n') ? '\r\n' : '\n';
        currentContent = eol === '\r\n' ? replacedNorm.replace(/\n/g, '\r\n') : replacedNorm;
      }
    }

    const hunks = computeHunks(relPath, originalContent, currentContent, options?.targetRange);

    const staged: StagedFileChange = {
      path: relPath,
      fullPath,
      originalContent,
      proposedContent: currentContent,
      hunks,
      isNewFile: isNew || Boolean(existing?.isNewFile),
      rationale: options?.rationale || existing?.rationale,
      targetRange: options?.targetRange || existing?.targetRange
    };

    this.stagedFiles.set(relPath, staged);
    this.notifyChange();
    return staged;
  }

  /**
   * Stages entire new content for a file.
   */
  public stageContent(
    filePath: string,
    content: string,
    options?: StageOptions
  ): StagedFileChange {
    const { relPath, fullPath } = this.normalizePath(filePath);
    const isNew = Boolean(options?.create);

    let originalContent: string;
    const existing = this.stagedFiles.get(relPath);
    if (existing) {
      originalContent = existing.originalContent;
    } else if (options?.originalContent !== undefined) {
      originalContent = options.originalContent;
    } else {
      originalContent = this.getOriginalContent(fullPath, isNew);
    }

    const hunks = computeHunks(relPath, originalContent, content, options?.targetRange);

    const staged: StagedFileChange = {
      path: relPath,
      fullPath,
      originalContent,
      proposedContent: content,
      hunks,
      isNewFile: isNew || Boolean(existing?.isNewFile),
      rationale: options?.rationale || existing?.rationale,
      targetRange: options?.targetRange || existing?.targetRange
    };

    this.stagedFiles.set(relPath, staged);
    this.notifyChange();
    return staged;
  }

  /**
   * Unstages a specific file or all files.
   */
  public unstage(filePath?: string): void {
    if (!filePath || filePath === 'all') {
      this.stagedFiles.clear();
    } else {
      const { relPath } = this.normalizePath(filePath);
      this.stagedFiles.delete(relPath);
    }
    this.notifyChange();
  }

  /**
   * Sets the review status of a specific hunk.
   */
  public setHunkStatus(filePath: string, hunkId: string, status: 'accepted' | 'rejected' | 'pending'): boolean {
    const { relPath } = this.normalizePath(filePath);
    const staged = this.stagedFiles.get(relPath);
    if (!staged) return false;

    const hunk = staged.hunks.find(h => h.id === hunkId);
    if (!hunk) return false;

    hunk.status = status;
    this.notifyChange();
    return true;
  }

  /**
   * Accepts all hunks in a file or across all files.
   */
  public acceptAllHunks(filePath?: string): void {
    if (filePath) {
      const { relPath } = this.normalizePath(filePath);
      const staged = this.stagedFiles.get(relPath);
      if (staged) {
        for (const h of staged.hunks) h.status = 'accepted';
      }
    } else {
      for (const staged of this.stagedFiles.values()) {
        for (const h of staged.hunks) h.status = 'accepted';
      }
    }
    this.notifyChange();
  }

  /**
   * Rejects all hunks in a file or across all files.
   */
  public rejectAllHunks(filePath?: string): void {
    if (filePath) {
      const { relPath } = this.normalizePath(filePath);
      const staged = this.stagedFiles.get(relPath);
      if (staged) {
        for (const h of staged.hunks) h.status = 'rejected';
      }
    } else {
      for (const staged of this.stagedFiles.values()) {
        for (const h of staged.hunks) h.status = 'rejected';
      }
    }
    this.notifyChange();
  }

  /**
   * Gets the final content with accepted hunks applied.
   */
  public getAcceptedContent(filePath: string): string {
    const { relPath } = this.normalizePath(filePath);
    const staged = this.stagedFiles.get(relPath);
    if (!staged) return '';
    return applyHunks(staged.originalContent, staged.hunks);
  }

  /**
   * Returns a summary representation of all currently staged changes.
   */
  public showStaged(): Array<{
    path: string;
    isNewFile: boolean;
    rationale?: string;
    hunkCount: number;
    acceptedHunks: number;
    rejectedHunks: number;
    pendingHunks: number;
    hunks: DiffHunk[];
  }> {
    return Array.from(this.stagedFiles.values()).map(s => {
      const accepted = s.hunks.filter(h => h.status === 'accepted').length;
      const rejected = s.hunks.filter(h => h.status === 'rejected').length;
      const pending = s.hunks.filter(h => h.status === 'pending').length;
      return {
        path: s.path,
        isNewFile: s.isNewFile,
        rationale: s.rationale,
        hunkCount: s.hunks.length,
        acceptedHunks: accepted,
        rejectedHunks: rejected,
        pendingHunks: pending,
        hunks: s.hunks
      };
    });
  }

  public clear(): void {
    this.stagedFiles.clear();
    this.notifyChange();
  }
}
