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

const WORD_RE = /[A-Za-z][A-Za-z'-]{3,}/g;   // matchAll needs /g
const HAS_WORD_RE = /[A-Za-z][A-Za-z'-]{3,}/; // .test() must stay stateless (a /g regex advances lastIndex across calls)
const CJK_RE = /[\u4e00-\u9fff]/;

/** Negation flips a directive's meaning — a summary that drops it has NOT
 *  preserved the constraint, no matter how high the word coverage scores. */
const NEGATION_RE = /\b(?:never|do\s+not|don'?t|shall\s+not)\b|(?:不要|不能|禁止|千万)/i;

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
  return HAS_WORD_RE.test(withoutMarker) || CJK_RE.test(withoutMarker);
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
    // Keep negations — 'never' carries semantics: a summary that drops it
    // must NOT count as surviving the constraint. Only drop pure structure
    // words (note/that/this/with) and affirmative modals (must/always/shall).
    if (!['must', 'always', 'shall', 'required', 'note', 'that', 'this', 'with'].includes(w)) {
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

const POLARITY_NEG_RE =
  /\b(?:not|no|never|cannot|can'?t|don'?t|doesn'?t|didn'?t|won'?t|without|forbid\w*|avoid)\b|(?:不要|不能|不得|禁止|切勿|避免|别)/i;

function isNegated(text: string): boolean {
  return POLARITY_NEG_RE.test(text);
}

/** Split a summary into candidate sentences (crude, conservative). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Content-word coverage of ONE candidate sentence against the constraint. */
function coverageOf(constraintText: string, candidateText: string): { ratio: number; hits: number; size: number } {
  const words = contentWords(constraintText);
  if (words.size === 0) return { ratio: 0, hits: 0, size: 0 };
  const cand = contentWords(candidateText);
  let hits = 0;
  for (const w of words) if (cand.has(w)) hits++;
  return { ratio: hits / words.size, hits, size: words.size };
}


export function verifySurvival(
  constraints: readonly Constraint[],
  summaryText: string,
  coverageThreshold = 0.6,
): SurvivalVerdict[] {
  const normSummary = normalizeWs(summaryText);
  const candidates = splitSentences(summaryText);

  return constraints.map((constraint) => {
    // coverage: content-word overlap against ONE candidate sentence (never
    // pooled across the whole summary — unrelated sentences must not vouch).
    // Verbatim: the exact normalized directive line survives whole. Its own
    // negation travels with it, so no separate polarity check is needed.
    const norm = normalizeWs(constraint.text);
    if (norm.length > 0 && normSummary.includes(norm)) {
      return { constraint, kept: true, how: 'verbatim' };
    }

    const constraintNegated = isNegated(constraint.text);
    const words = contentWords(constraint.text);

    // Find the single best-matching candidate sentence.
    let bestText: string | undefined;
    let bestRatio = 0;
    for (const cand of candidates) {
      const { ratio } = coverageOf(constraint.text, cand);
      if (ratio > bestRatio) { bestRatio = ratio; bestText = cand; }
    }

    if (bestText === undefined || bestRatio < coverageThreshold) {
      return { constraint, kept: false, how: 'lost' };
    }

    // Polarity binding: the surviving sentence must carry the same negation
    // state as the directive. "Never commit to main" surviving as
    // "Commit to main" (or the reverse flip) is a semantic flip, not survival.
    if (constraintNegated !== isNegated(bestText)) {
      return { constraint, kept: false, how: 'lost-polarity' };
    }

    return { constraint, kept: true, how: `coverage:${bestRatio.toFixed(2)}` };
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
