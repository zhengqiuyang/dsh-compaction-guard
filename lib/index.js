import Schema from '@deepseek-ai/schemastery';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { collectText, extractConstraints, summarizeVerdicts, verifySurvival, } from './constraints.js';
export const name = 'dsh-compaction-guard';
export const Config = Schema.object({
    pinned: Schema.array(Schema.string()).default([]).description('constraints that must survive every compaction'),
    coverage: Schema.number().default(0.6).description('content-word coverage that counts as survived'),
    ledgerPath: Schema.string().default('.dsh-compaction-guard/ledger.jsonl').description('JSONL ledger path; empty disables'),
    quiet: Schema.boolean().default(false).description('suppress console warnings'),
});
async function appendLedger(path, line) {
    try {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, JSON.stringify(line) + '\n', 'utf8');
    }
    catch (err) {
        console.warn(`[dsh-compaction-guard] ledger append failed: ${String(err)}`);
    }
}
export function apply(ctx, config) {
    const pinned = config.pinned.map((text, i) => ({ text, seq: -1 - i }));
    console.log(`[dsh-compaction-guard] active: watching compaction/summary (pinned=${pinned.length}, coverage=${config.coverage}, ledger=${config.ledgerPath === '' ? 'off' : config.ledgerPath})`);
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'compaction/summary')
            return;
        const data = event.data;
        const summaryText = collectText(data?.summary).join('\n');
        const shadowedSeqs = data?.shadowedSeqs ?? [];
        // Directive lines from the user-authored events being compacted away.
        const constraints = [...pinned];
        for (const seq of shadowedSeqs) {
            const ev = session.eventAt(seq);
            if (ev === undefined || ev.type !== 'user/message')
                continue;
            const lines = collectText(ev.data)
                .join('\n')
                .split('\n')
                .map((text) => ({ text, seq }));
            constraints.push(...extractConstraints(lines));
        }
        const verdicts = verifySurvival(constraints, summaryText, config.coverage);
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
