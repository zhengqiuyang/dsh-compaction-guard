/**
 * Pure constraint extraction and survival verification. A constraint is a
 * directive line from user-authored text ("never commit to main", "必须先跑
 * 测试") — identified by determinstic marker patterns, never by an LLM.
 * Survival means the constraint survives a compaction summary verbatim
 * (whitespace-normalized substring) or in substance (>= coverage threshold
 * of its content words appear in the summary).
 */

/** Marker words that mark a line as a standing directive (en + zh). */
const CONSTRAINT_MARKER_RE =
  /\b(?:must|always|never|do\s+not|don'?t|shall\s+not|required\s+to)\b|(?:必须|务必|不要|不能|禁止|千万)/i;

const WORD_RE = /[A-Za-z][A-Za-z'-]{3,}/g;
const CJK_RE = /[\u4e00-\u9fff]/;

export interface Constraint {
  /** Raw directive line, as the user wrote it. */
  text: string;
  /** Session seq the line came from (for reporting). */
  seq: number;
}

export function isConstraintLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 8 || trimmed.length > 400) return false;
  // URLs are references, not directives — marker words inside them are noise.
  if (/https?:\/\//.test(trimmed)) return false;
  if (!CONSTRAINT_MARKER_RE.test(trimmed)) return false;
  // Must carry actual content: an English word beyond the marker or CJK.
  const withoutMarker = trimmed.replace(CONSTRAINT_MARKER_RE, '');
  return WORD_RE.test(withoutMarker) || CJK_RE.test(withoutMarker);
}

export function extractConstraints(lines: readonly { text: string; seq: number }[]): Constraint[] {
  return lines.filter((l) => isConstraintLine(l.text)).map((l) => ({ text: l.text.trim(), seq: l.seq }));
}

/** Collapse whitespace and lowercase — "never  commit" == "never commit". */
export function normalizeWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const m of text.toLowerCase().matchAll(WORD_RE)) {
    const w = m[0] ?? '';
    // Drop the bare markers themselves — they are structure, not content.
    if (!['must', 'always', 'never', 'shall', 'required', 'dont', 'note', 'that', 'this', 'with'].includes(w)) {
      words.add(w);
    }
  }
  for (const m of text.matchAll(/[\u4e00-\u9fff]{2,4}/g)) {
    words.add(m[0] ?? '');
  }
  return words;
}

export interface SurvivalVerdict {
  constraint: Constraint;
  kept: boolean;
  /** How it survived: verbatim | coverage:<n> | lost */
  how: string;
}

export function verifySurvival(
  constraints: readonly Constraint[],
  summaryText: string,
  coverageThreshold = 0.6,
): SurvivalVerdict[] {
  const normSummary = normalizeWs(summaryText);
  const summaryWords = contentWords(summaryText);
  return constraints.map((constraint) => {
    const norm = normalizeWs(constraint.text);
    if (norm.length > 0 && normSummary.includes(norm)) {
      return { constraint, kept: true, how: 'verbatim' };
    }
    const words = contentWords(constraint.text);
    if (words.size === 0) return { constraint, kept: false, how: 'lost' };
    let hits = 0;
    for (const w of words) if (summaryWords.has(w)) hits++;
    const coverage = hits / words.size;
    if (coverage >= coverageThreshold) {
      return { constraint, kept: true, how: `coverage:${coverage.toFixed(2)}` };
    }
    return { constraint, kept: false, how: 'lost' };
  });
}

export function summarizeVerdicts(verdicts: readonly SurvivalVerdict[]): string {
  const lost = verdicts.filter((v) => !v.kept);
  if (lost.length === 0) return `all ${verdicts.length} constraint(s) survived compaction`;
  return `${lost.length}/${verdicts.length} constraint(s) LOST in compaction:\n` +
    lost.map((v) => `  - (seq ${v.constraint.seq}) ${v.constraint.text.slice(0, 120)}`).join('\n');
}

/**
 * Defensive text extraction from an unknown user-message payload shape:
 * collects every reasonably long string nested in the value (depth-bounded).
 * The session event schema is the harness's to evolve; this stays standing.
 */
export function collectText(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === 'string') {
    return value.length >= 8 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) => collectText(v, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key === 'id' || key === 'time' || key === 'seq') continue;
      out.push(...collectText((value as Record<string, unknown>)[key], depth + 1));
    }
    return out;
  }
  return [];
}
