export interface DiffHunk {
  id: string;
  file: string;
  originalStartLine: number; // 1-based
  originalLineCount: number;
  proposedStartLine: number; // 1-based
  proposedLineCount: number;
  originalLines: string[];
  proposedLines: string[];
  status: 'pending' | 'accepted' | 'rejected';
  outsideSelection?: boolean;
}

export interface TargetRange {
  startLine: number; // 1-based
  endLine: number;   // 1-based
}

export function detectLineEnding(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

export function splitContent(content: string): { lines: string[]; hasTrailingNewline: boolean; eol: '\r\n' | '\n' } {
  const eol = detectLineEnding(content);
  if (!content) {
    return { lines: [], hasTrailingNewline: false, eol };
  }
  const hasTrailingNewline = content.endsWith('\n');
  const normalized = hasTrailingNewline ? content.replace(/\r?\n$/, '') : content;
  const lines = normalized.split(/\r?\n/);
  return { lines, hasTrailingNewline, eol };
}

type DiffOp =
  | { type: 'keep'; aLine: string; aIdx: number; bIdx: number }
  | { type: 'delete'; aLine: string; aIdx: number }
  | { type: 'insert'; bLine: string; bIdx: number };

/**
 * Robust LCS line-by-line diff algorithm.
 */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const N = a.length;
  const M = b.length;

  if (N === 0 && M === 0) return [];
  if (N === 0) {
    return b.map((bLine, idx) => ({ type: 'insert', bLine, bIdx: idx }));
  }
  if (M === 0) {
    return a.map((aLine, idx) => ({ type: 'delete', aLine, aIdx: idx }));
  }

  // 2D DP table
  const dp: number[][] = [];
  for (let i = 0; i <= N; i++) {
    dp.push(new Array(M + 1).fill(0));
  }

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      if (a[i] === b[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i][j + 1], dp[i + 1][j]);
      }
    }
  }

  // Backtrack from (N, M) to (0, 0)
  const ops: DiffOp[] = [];
  let i = N;
  let j = M;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ type: 'keep', aLine: a[i - 1], aIdx: i - 1, bIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'insert', bLine: b[j - 1], bIdx: j - 1 });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      ops.unshift({ type: 'delete', aLine: a[i - 1], aIdx: i - 1 });
      i--;
    }
  }

  return ops;
}

/**
 * Checks whether a diff hunk falls outside a target line selection.
 */
export function isHunkOutsideSelection(
  originalStartLine: number,
  originalLineCount: number,
  targetRange?: TargetRange
): boolean {
  if (!targetRange) return false;
  const hunkStart = originalStartLine;
  const hunkEnd = originalLineCount > 0 ? originalStartLine + originalLineCount - 1 : originalStartLine;
  return hunkEnd < targetRange.startLine || hunkStart > targetRange.endLine;
}

/**
 * Computes DiffHunks between original and proposed file content.
 */
export function computeHunks(
  filePath: string,
  originalContent: string,
  proposedContent: string,
  targetRange?: TargetRange
): DiffHunk[] {
  const { lines: aLines } = splitContent(originalContent);
  const { lines: bLines } = splitContent(proposedContent);

  const ops = lcsDiff(aLines, bLines);
  const hunks: DiffHunk[] = [];

  let currentOriginalLines: string[] = [];
  let currentProposedLines: string[] = [];
  let hunkOrigStart = -1;
  let hunkPropStart = -1;
  let runningOrigLine = 1;
  let runningPropLine = 1;

  function flushHunk() {
    if (currentOriginalLines.length > 0 || currentProposedLines.length > 0) {
      const origLineCount = currentOriginalLines.length;
      const propLineCount = currentProposedLines.length;
      const hunkIndex = hunks.length;
      const outside = isHunkOutsideSelection(hunkOrigStart, origLineCount, targetRange);

      hunks.push({
        id: `hunk-${hunkIndex}`,
        file: filePath,
        originalStartLine: hunkOrigStart,
        originalLineCount: origLineCount,
        proposedStartLine: hunkPropStart,
        proposedLineCount: propLineCount,
        originalLines: [...currentOriginalLines],
        proposedLines: [...currentProposedLines],
        status: 'pending',
        outsideSelection: outside
      });

      currentOriginalLines = [];
      currentProposedLines = [];
      hunkOrigStart = -1;
      hunkPropStart = -1;
    }
  }

  for (const op of ops) {
    if (op.type === 'keep') {
      flushHunk();
      runningOrigLine++;
      runningPropLine++;
    } else if (op.type === 'delete') {
      if (hunkOrigStart === -1) {
        hunkOrigStart = runningOrigLine;
        hunkPropStart = runningPropLine;
      }
      currentOriginalLines.push(op.aLine);
      runningOrigLine++;
    } else if (op.type === 'insert') {
      if (hunkOrigStart === -1) {
        hunkOrigStart = runningOrigLine;
        hunkPropStart = runningPropLine;
      }
      currentProposedLines.push(op.bLine);
      runningPropLine++;
    }
  }
  flushHunk();

  return hunks;
}

/**
 * Applies only accepted hunks to the original content, preserving CRLF / LF line endings.
 */
export function applyHunks(
  originalContent: string,
  hunks: DiffHunk[],
  explicitEol?: '\r\n' | '\n'
): string {
  const { lines: origLines, hasTrailingNewline, eol } = splitContent(originalContent);
  const finalEol = explicitEol ?? eol;

  if (hunks.length === 0) {
    return originalContent;
  }

  // If original was completely empty and file is newly created
  if (origLines.length === 0 && originalContent === '') {
    const acceptedLines: string[] = [];
    for (const h of hunks) {
      if (h.status === 'accepted') {
        acceptedLines.push(...h.proposedLines);
      }
    }
    return acceptedLines.join(finalEol) + (acceptedLines.length > 0 ? finalEol : '');
  }

  // Sort hunks by originalStartLine ascending
  const sorted = [...hunks].sort((a, b) => a.originalStartLine - b.originalStartLine);

  const resultLines: string[] = [];
  let origCursor = 0; // 0-based line index in origLines

  for (const hunk of sorted) {
    // 0-based target start line
    const targetStart = Math.max(0, hunk.originalStartLine - 1);

    // Copy unchanged original lines before this hunk
    while (origCursor < targetStart && origCursor < origLines.length) {
      resultLines.push(origLines[origCursor]);
      origCursor++;
    }

    if (hunk.status === 'accepted') {
      // Use proposed lines
      resultLines.push(...hunk.proposedLines);
      // Skip original lines that were replaced
      origCursor += hunk.originalLineCount;
    } else {
      // Hunk was rejected or pending: keep original lines
      const count = hunk.originalLineCount;
      for (let i = 0; i < count && origCursor < origLines.length; i++) {
        resultLines.push(origLines[origCursor]);
        origCursor++;
      }
    }
  }

  // Copy any remaining original lines
  while (origCursor < origLines.length) {
    resultLines.push(origLines[origCursor]);
    origCursor++;
  }

  const trailing = hasTrailingNewline ? finalEol : '';
  return resultLines.join(finalEol) + trailing;
}
