# docs/

Current contracts, references and decisions only. Process records, one-off investigations and finished plans do not stay at the top level.

## Layout

```
docs/
├── AGENTS.md         # this file: placement + lifecycles
├── *.md              # current truth: contracts and topic refs
├── adr/              # accepted durable decisions; numbered, append-only
├── plans/            # plans in flight; a finished plan here is a doc error
│   └── archive/      # finished, superseded, abandoned; history, not current truth
├── migrations/       # one-off migration design, data and rehearsal records
└── prototypes/       # one directory per prototype; state is the directory
    ├── in-progress/  # production UI is written against these; reviews and edits happen here
    ├── deprecated/   # generated then rejected: negative evidence, frozen
    └── archive/      # implemented: frozen, used to reconcile what a version looked like
```

Domain terms: root `GLOSSARY.md`. Script rules: `scripts/AGENTS.md`.

## Rules

- Names: lowercase kebab-case, no dates, no `-final` / `-v2`. A plan name describes the task; a prototype name describes the surface.
- Links are relative. Moving a file means updating every reference — indexes, `PRODUCT.md` evidence list, code comments.
- Applied SQL migrations are immutable history: never rewrite their comments to rename a checksum.
- Current behavior = code + tests + top-level contracts. An archived plan explains why then, not what is true now.

## Prototypes

Static HTML/CSS/JS, never in the production build. Each prototype carries its own `README.md` for review notes, known limits and demo-data declarations; change the prototype itself, not a copy of it. One still sitting in `in-progress/` after it shipped or was rejected is a doc error.

1. **Adopt** — design lands in production: move to `prototypes/archive/<name>/`, add archived date + implementing version to its `README.md`, extract settled tokens into the production token definitions.
2. **Reject** — move to `prototypes/deprecated/<name>/`, one line in its `README.md` on why, then stop editing.
3. **After any move** — sync references: `PRODUCT.md` evidence list, the prototype's own open command, and the path-named brief under `.impeccable/surfaces/` (rewrite at the new path, delete the old).

## Plan lifecycle

1. **Start** — new plan in `plans/`; goal and scope, no "maybe later".
2. **Advance** — the plan is a live document: keep status, acceptance results and unproven edges current. Link to code for commands, schemas and test lists; never restate them as a second source of truth.
3. **Finish or supersede** — extract the decisions that clear the ADR bar into `adr/`; everything else just archives.
4. **Archive** — move to `plans/archive/<name>.md`; under the title add archive date, current entry point and related ADR links; index it in `plans/archive/README.md`; fix references.
5. **After archive** — keep conclusions, commands and evidence links as of then. Do not rewrite them into "still true now"; link current docs or write a new ADR instead.

## ADR bar

All three must hold: changing it later is expensive; a new reader would ask "why is it like this"; a real alternative existed and a concrete reason picked this one.

Typically 0–3 ADRs per plan. Implementation order, commands, table names and test counts are not ADRs — they stay in the archived plan or the code.
