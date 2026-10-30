# paimeng-ai-code-mother

AI web-app generator: users describe what they want in natural language; the platform generates, validates, previews and publishes the site.

## Layering

```
/
├── AGENTS.md               # this file: repo navigation; each subdirectory has its own
├── PRODUCT.md              # product scope, users, stack, prototype lifecycle
├── GLOSSARY.md             # domain terms; `_Avoid_` lines list the synonyms not to use
├── docs/
│   └── agents/             # engineering-skill config: issue tracker, triage labels, domain docs
├── archive/                # old Java + Vue code, read-only reference; never current truth
└── paimeng-ai-code-agent/  # the product (Next.js + TS); its own AGENTS.md takes over
```

This file covers the root level only. Layout, commands and code conventions for `paimeng-ai-code-agent/` live in its own `AGENTS.md` and in the `AGENTS.md` files below it, and must not be duplicated here.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `ZDAN-GHN/paimeng-ai-code-mother`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their own names as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` plus ADRs in `paimeng-ai-code-agent/docs/adr/`. See `docs/agents/domain.md`.
