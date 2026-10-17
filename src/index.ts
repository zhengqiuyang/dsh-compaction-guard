/**
 * dsh-compaction-guard — compaction integrity for DeepSeek Harness.
 *
 * Long sessions compact; constraints can silently vanish with the compacted
 * range. This plugin watches `compaction/summary` session events: it
 * extracts directive lines ("never ...", "must ...", "不要…") from the
 * user-authored events being shadowed, verifies each against the summary
 * (verbatim or substance coverage), and reports every constraint the agent
 * just forgot — to the console and to a durable JSONL ledger. Pinned
 * constraints from config are always verified. Zero LLM calls in the
 * trust path.
 *
 * Family: ... freeze (what exactly is running) · **compaction-guard (what
 * the agent remembers)**.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  collectText,
  extractConstraints,
  summarizeVerdicts,
  verifySurvival,
  type Constraint,
  type SurvivalVerdict,
} from './constraints.js';

export const name = 'dsh-compaction-guard';

export interface Config {
  /** Extra constraints that must survive every compaction, verbatim-checked. */
  pinned: string[];
  /** Substance threshold: fraction of a constraint's content words that must appear in the summary. */
  coverage: number;
  /** JSONL ledger of compaction verdicts; empty string disables. */
  ledgerPath: string;
  quiet: boolean;
}

export const Config: Schema<Config> = Schema.object({
  pinned: Schema.array(Schema.string()).default([]).description('constraints that must survive every compaction'),
  coverage: Schema.number().default(0.6).description('content-word coverage that counts as survived'),
  ledgerPath: Schema.string().default('.dsh-compaction-guard/ledger.jsonl').description('JSONL ledger path; empty disables'),
  quiet: Schema.boolean().default(false).description('suppress console warnings'),
});

// Harness surface restated so the plugin typechecks standalone; identical
// declarations merge cleanly inside the source checkout.
interface SessionView {
  id: string;
  eventAt(seq: number): { type: string; data?: unknown } | undefined;
}

interface SummaryEventView {
  type: string;
  data?: {
    compactionId?: string;
    summary?: unknown[];
    shadowedSeqs?: number[];
  };
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/event': (session: SessionView, event: SummaryEventView) => void;
  }
}

interface LedgerLine {
  time: string;
  sessionId: string;
  compactionId: string;
  constraints: number;
  kept: number;
  lost: { seq: number; text: string }[];
}

async function appendLedger(path: string, line: LedgerLine): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(line) + '\n', 'utf8');
  } catch (err) {
    console.warn(`[dsh-compaction-guard] ledger append failed: ${String(err)}`);
  }
}

export function apply(ctx: Context, config: Config) {
  const pinned: Constraint[] = config.pinned.map((text, i) => ({ text, seq: -1 - i }));
  console.log(
    `[dsh-compaction-guard] active: watching compaction/summary (pinned=${pinned.length}, coverage=${config.coverage}, ledger=${config.ledgerPath === '' ? 'off' : config.ledgerPath})`,
  );

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/summary') return;
    const data = event.data;
    const summaryText = collectText(data?.summary).join('\n');
    const shadowedSeqs = data?.shadowedSeqs ?? [];

    // Directive lines from the user-authored events being compacted away.
    const constraints: Constraint[] = [...pinned];
    for (const seq of shadowedSeqs) {
      const ev = session.eventAt(seq);
      if (ev === undefined || ev.type !== 'user/message') continue;
      const lines = collectText(ev.data)
        .join('\n')
        .split('\n')
        .map((text) => ({ text, seq }));
      constraints.push(...extractConstraints(lines));
    }

    const verdicts: SurvivalVerdict[] = verifySurvival(constraints, summaryText, config.coverage);
    const lost = verdicts.filter((v) => !v.kept);
    if (!config.quiet && verdicts.length > 0) {
      const level = lost.length > 0 ? console.warn : console.log;
      level(`[dsh-compaction-guard] ${summarizeVerdicts(verdicts)}`);
    }
    if (config.ledgerPath !== '' && verdicts.length > 0) {
      void appendLedger(config.ledgerPath, {
        time: new Date().toISOString(),
        sessionId: String(session.id),
        compactionId: String(data?.compactionId ?? ''),
        constraints: verdicts.length,
        kept: verdicts.length - lost.length,
        lost: lost.map((v) => ({ seq: v.constraint.seq, text: v.constraint.text })),
      });
    }
  });
}
