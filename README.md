# dsh-compaction-guard

> **If this helps you, please give it a star** — it helps others find it. Thanks!
Compaction integrity for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Long sessions compact; the compacted range takes constraints with it — "never
commit to main", "必须先跑测试" — and the agent silently forgets rules it was
told to keep. This plugin watches `compaction/summary` session events: it
extracts directive lines from the user-authored events being shadowed,
verifies each against the summary (**verbatim**, whitespace-normalized, or
**in substance** — a coverage threshold on content words), and reports every
constraint the agent just forgot — console plus a durable JSONL ledger.
Pinned constraints from config are verified on every compaction. Zero LLM
calls in the trust path.

Family channel #9: read / write / do / call / leave-behind / egress / told /
running / **remembered — what the agent forgets**.

## Why now (checked 2026-10-17)

The awesome list has 209 memory plugins and an entire compaction package
family in dsh itself — and **not one verifies that constraints survive
compaction**. Memory plugins add recall; this audits loss. The
`compaction/summary` event even ships `shadowedSeqs` (exactly what was
compact away) — the integrity check is deterministic by construction.

## How it works

```
compaction/summary event
  ├── shadowedSeqs → session.eventAt(seq) → user/message directive lines
  ├── pinned constraints from config (always verified)
  ├── verify against the summary text:
  │     verbatim (whitespace-normalized substring)  → kept
  │     content-word coverage ≥ threshold (default 0.6) → kept
  │     otherwise                                     → LOST (reported + ledgered)
  └── ledger: .dsh-compaction-guard/ledger.jsonl (CI-consumable)
```

Honest limitation, on purpose: word coverage tracks **words, not meaning** —
a summary that rewords "run the tests" as "execute the checks" with no
shared vocabulary counts as lost (conservative direction: false alarm, not
silent loss). Synonym-aware matching would need embeddings or an LLM, which
is exactly what this family refuses to put in the trust path.

## Install

```sh
dsh plugin --profile default add github:zhengqiuyang/dsh-compaction-guard
```

Prebuilt `lib/` ships in the repo — no build step, no `allowBuilds`.

## Configure

```yaml
- id: dsh-compaction-guard
  name: dsh-compaction-guard
  config:
    pinned: ["Never force-push to main"]   # always verified, verbatim
    coverage: 0.6
    ledgerPath: .dsh-compaction-guard/ledger.jsonl
```

## Compatibility

- **DSH**: verified against the 0.2.x line (source snapshot 0.2.1-alpha.2); installs on any profile via `dsh plugin add` (prebuilt `lib/`, no build approval).
- **Node**: >= 20 (CI matrix: Node 20/22/24 on Ubuntu and Windows).
- **Disposable-profile evidence (2026-10-19)**: `dsh plugin --profile <fresh> add github:zhengqiuyang/dsh-compaction-guard` → installed in 30s; boot shows `[dsh-compaction-guard] active: …`; `dsh plugin --profile <fresh> remove dsh-compaction-guard` → dependencies cleared, bundles restored.

## Develop

```sh
npm install && npm test
```

## Roadmap

- `reinject` mode: steer the lost constraints back into the session after
  compaction (default stays observe — auto-injection deserves live testing
  first)
- Post-compaction reassertion listener (a constraint restated after the
  summary also counts as survived)
- Turn-boundary constraints (task briefs in the first turn pinned per-turn)

## Kill criteria

If dsh ships first-party compaction-integrity verification, this freezes at
its last working version with a postmortem here.
