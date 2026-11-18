import { BM25SearchResult } from './bm25.js';

export const BUDGET_CONSTANTS = {
  REPO_MAP_MAX_TOKENS: 1500,
  RETRIEVE_CONTEXT_MAX_TOKENS: 6000,
  TURN_CAP_MAX_TOKENS: 8000
};

export interface PackedContextItem {
  path: string;
  lines: [number, number];
  score: number;
  why: string;
  tokens: number;
}

export interface PackedContextResult {
  items: PackedContextItem[];
  packedCode: string;
  usedTokens: number;
  maxTokens: number;
  remainingTokens: number;
  footer: string;
}

/**
 * Estimates token count for text using standard ~4 chars/token heuristic.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Packs ranked search results within token budget.
 * Formats packed code with clear headers and appends the required budget footer.
 */
export function packContext(
  results: BM25SearchResult[],
  maxTokens: number = BUDGET_CONSTANTS.RETRIEVE_CONTEXT_MAX_TOKENS
): PackedContextResult {
  const items: PackedContextItem[] = [];
  const packedSections: string[] = [];
  let accumulatedTokens = 0;

  // Header and footer reserve
  const footerReserve = 30; // budget for footer line
  const effectiveBudget = Math.max(0, maxTokens - footerReserve);

  for (const res of results) {
    const doc = res.document;
    const header = `=== File: ${doc.relativePath} (lines ${doc.startLine}-${doc.endLine}) [score: ${res.score}] ===`;
    const sectionText = `${header}\n${doc.content}\n`;
    const tokens = estimateTokens(sectionText);

    if (accumulatedTokens + tokens > effectiveBudget && items.length > 0) {
      // Reached budget limit
      break;
    }

    accumulatedTokens += tokens;
    items.push({
      path: doc.relativePath,
      lines: [doc.startLine, doc.endLine],
      score: res.score,
      why: res.why,
      tokens
    });
    packedSections.push(sectionText);
  }

  const remainingTokens = Math.max(0, maxTokens - accumulatedTokens);
  const footer = `[Context Budget: ${accumulatedTokens}/${maxTokens} tokens (${remainingTokens} remaining)]`;

  const packedCode = packedSections.length > 0
    ? `${packedSections.join('\n')}\n${footer}`
    : footer;

  return {
    items,
    packedCode,
    usedTokens: accumulatedTokens,
    maxTokens,
    remainingTokens,
    footer
  };
}
