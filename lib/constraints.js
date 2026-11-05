/**
 * Pure constraint extraction and survival verification. A constraint is a
 * directive line from user-authored text ("never commit to main", "必须先跑
 * 测试") — identified by determinstic marker patterns, never by an LLM.
 * Survival means the constraint survives a compaction summary verbatim
 * (whitespace-normalized substring) or in substance (>= coverage threshold
 * of its content words appear in the summary).
 */
/** Marker words that mark a line as a standing directive (en + zh). */
const CONSTRAINT_MARKER_RE = /\b(?:must|always|never|do\s+not|don'?t|shall\s+not|required\s+to)\b|(?:必须|务必|不要|不能|禁止|千万)/i;
const WORD_RE = /[A-Za-z][A-Za-z'-]{3,}/g; // matchAll needs /g
const HAS_WORD_RE = /[A-Za-z][A-Za-z'-]{3,}/; // .test() must stay stateless (a /g regex advances lastIndex across calls)
const CJK_RE = /[\u4e00-\u9fff]/;
/** Negation flips a directive's meaning — a summary that drops it has NOT
 *  preserved the constraint, no matter how high the word coverage scores. */
const NEGATION_RE = /\b(?:never|do\s+not|don'?t|shall\s+not)\b|(?:不要|不能|禁止|千万)/i;
export function isConstraintLine(line) {
    const trimmed = line.trim();
    if (trimmed.length < 8 || trimmed.length > 400)
        return false;
    // URLs are references, not directives — marker words inside them are noise.
    if (/https?:\/\//.test(trimmed))
        return false;
    if (!CONSTRAINT_MARKER_RE.test(trimmed))
        return false;
    // Must carry actual content: an English word beyond the marker or CJK.
    const withoutMarker = trimmed.replace(CONSTRAINT_MARKER_RE, '');
    return HAS_WORD_RE.test(withoutMarker) || CJK_RE.test(withoutMarker);
}
export function extractConstraints(lines) {
    return lines.filter((l) => isConstraintLine(l.text)).map((l) => ({ text: l.text.trim(), seq: l.seq }));
}
/** Collapse whitespace and lowercase — "never  commit" == "never commit". */
export function normalizeWs(text) {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
}
function contentWords(text) {
    const words = new Set();
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
export function verifySurvival(constraints, summaryText, coverageThreshold = 0.6) {
    const normSummary = normalizeWs(summaryText);
    const summaryWords = contentWords(summaryText);
    return constraints.map((constraint) => {
        // Semantic flip guard: a negative directive whose summary lost the
        // negation is lost — coverage alone would score the flipped sentence high.
        if (NEGATION_RE.test(constraint.text) && !NEGATION_RE.test(summaryText)) {
            return { constraint, kept: false, how: 'lost-negation' };
        }
        const norm = normalizeWs(constraint.text);
        if (norm.length > 0 && normSummary.includes(norm)) {
            return { constraint, kept: true, how: 'verbatim' };
        }
        const words = contentWords(constraint.text);
        if (words.size === 0)
            return { constraint, kept: false, how: 'lost' };
        let hits = 0;
        for (const w of words)
            if (summaryWords.has(w))
                hits++;
        const coverage = hits / words.size;
        if (coverage >= coverageThreshold) {
            return { constraint, kept: true, how: `coverage:${coverage.toFixed(2)}` };
        }
        return { constraint, kept: false, how: 'lost' };
    });
}
export function summarizeVerdicts(verdicts) {
    const lost = verdicts.filter((v) => !v.kept);
    if (lost.length === 0)
        return `all ${verdicts.length} constraint(s) survived compaction`;
    return `${lost.length}/${verdicts.length} constraint(s) LOST in compaction:\n` +
        lost.map((v) => `  - (seq ${v.constraint.seq}) ${v.constraint.text.slice(0, 120)}`).join('\n');
}
/**
 * Defensive text extraction from an unknown user-message payload shape:
 * collects every reasonably long string nested in the value (depth-bounded).
 * The session event schema is the harness's to evolve; this stays standing.
 */
export function collectText(value, depth = 0) {
    if (depth > 6)
        return [];
    if (typeof value === 'string') {
        return value.length >= 8 ? [value] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((v) => collectText(v, depth + 1));
    }
    if (value !== null && typeof value === 'object') {
        const out = [];
        for (const key of Object.keys(value)) {
            if (key === 'id' || key === 'time' || key === 'seq')
                continue;
            out.push(...collectText(value[key], depth + 1));
        }
        return out;
    }
    return [];
}
