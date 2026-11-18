import { SymbolInfo, splitIdentifier, tokenizeCode } from './symbols.js';

export interface IndexedDocument {
  id: string;
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  content: string;
  symbols: SymbolInfo[];
  companionPaths?: string[];
}

export interface BM25SearchResult {
  document: IndexedDocument;
  score: number;
  why: string;
}

export class BM25Index {
  private k1: number;
  private b: number;
  private documents: Map<string, IndexedDocument> = new Map();
  // Term -> Set of document IDs containing term
  private termDocFreq: Map<string, number> = new Map();
  // Doc ID -> Map of term -> effective frequency (content + 3x symbol + 2x path)
  private docTermFreqs: Map<string, Map<string, number>> = new Map();
  // Doc ID -> breakdown for explanation
  private docSymbolTerms: Map<string, Set<string>> = new Map();
  private docPathTerms: Map<string, Set<string>> = new Map();
  // Doc ID -> length
  private docLengths: Map<string, number> = new Map();
  private totalDocLength: number = 0;

  constructor(k1: number = 1.2, b: number = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  public clear(): void {
    this.documents.clear();
    this.termDocFreq.clear();
    this.docTermFreqs.clear();
    this.docSymbolTerms.clear();
    this.docPathTerms.clear();
    this.docLengths.clear();
    this.totalDocLength = 0;
  }

  public addDocument(doc: IndexedDocument): void {
    this.documents.set(doc.id, doc);

    const termFreqs = new Map<string, number>();
    const symbolTermSet = new Set<string>();
    const pathTermSet = new Set<string>();

    // 1. Content terms (1x base frequency)
    const contentTokens = tokenizeCode(doc.content);
    for (const t of contentTokens) {
      termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
    }

    // 2. Symbol boost (3x boost)
    for (const sym of doc.symbols) {
      for (const t of sym.tokens) {
        if (!t) continue;
        symbolTermSet.add(t);
        termFreqs.set(t, (termFreqs.get(t) || 0) + 3);
      }
    }

    // 3. Path boost (2x boost)
    const pathTokens = splitIdentifier(doc.relativePath);
    for (const t of pathTokens) {
      if (!t) continue;
      pathTermSet.add(t);
      termFreqs.set(t, (termFreqs.get(t) || 0) + 2);
    }

    // Update document length & totals
    const docLen = Math.max(1, contentTokens.length);
    this.docLengths.set(doc.id, docLen);
    this.totalDocLength += docLen;

    this.docTermFreqs.set(doc.id, termFreqs);
    this.docSymbolTerms.set(doc.id, symbolTermSet);
    this.docPathTerms.set(doc.id, pathTermSet);

    // Update document frequencies
    for (const term of termFreqs.keys()) {
      this.termDocFreq.set(term, (this.termDocFreq.get(term) || 0) + 1);
    }
  }

  public search(query: string, limit: number = 20, allowedPaths?: Set<string>): BM25SearchResult[] {
    const N = this.documents.size;
    if (N === 0) return [];

    const queryTokens = Array.from(new Set(tokenizeCode(query)));
    if (queryTokens.length === 0) return [];

    const avgdl = this.totalDocLength / N;
    const scores: Array<{ docId: string; score: number; why: string }> = [];

    for (const [docId, doc] of this.documents.entries()) {
      if (allowedPaths && !allowedPaths.has(doc.relativePath) && !allowedPaths.has(doc.filePath)) {
        continue;
      }

      const termFreqs = this.docTermFreqs.get(docId)!;
      const docLen = this.docLengths.get(docId) || 1;
      const symbolTerms = this.docSymbolTerms.get(docId) || new Set();
      const pathTerms = this.docPathTerms.get(docId) || new Set();

      let docScore = 0;
      const matchedSymbols: string[] = [];
      const matchedPaths: string[] = [];
      const matchedContent: string[] = [];

      for (const q of queryTokens) {
        const tf = termFreqs.get(q) || 0;
        if (tf === 0) continue;

        const n = this.termDocFreq.get(q) || 0;
        // Standard Robertson-Spärck Jones IDF
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));

        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / avgdl));
        docScore += Math.max(0, idf * (numerator / denominator));

        if (symbolTerms.has(q)) {
          matchedSymbols.push(q);
        } else if (pathTerms.has(q)) {
          matchedPaths.push(q);
        } else {
          matchedContent.push(q);
        }
      }

      if (docScore > 0) {
        const whyParts: string[] = [];
        if (matchedSymbols.length > 0) {
          whyParts.push(`symbol boost (3x) on [${matchedSymbols.slice(0, 3).join(', ')}]`);
        }
        if (matchedPaths.length > 0) {
          whyParts.push(`path boost (2x) on [${matchedPaths.slice(0, 3).join(', ')}]`);
        }
        if (matchedContent.length > 0) {
          whyParts.push(`content match on [${matchedContent.slice(0, 3).join(', ')}]`);
        }

        scores.push({
          docId,
          score: Number(docScore.toFixed(4)),
          why: whyParts.join('; ') || 'BM25 match'
        });
      }
    }

    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, limit).map(s => ({
      document: this.documents.get(s.docId)!,
      score: s.score,
      why: s.why
    }));
  }

  public getDocument(id: string): IndexedDocument | undefined {
    return this.documents.get(id);
  }

  public getAllDocuments(): IndexedDocument[] {
    return Array.from(this.documents.values());
  }
}
