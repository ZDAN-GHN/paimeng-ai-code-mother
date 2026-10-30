# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root — the product vocabulary (written in Chinese; each term lists the `_Avoid_` synonyms).
- **`paimeng-ai-code-agent/docs/adr/`** — read the ADRs that touch the area you're about to work in.
- **`PRODUCT.md`** — product scope, users, and stack. **`paimeng-ai-code-agent/AGENTS.md`** — code conventions for the app package.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo. The product code lives in one package, so the glossary stays at the root and the ADRs sit next to the code they govern:

```
/
├── GLOSSARY.md
├── PRODUCT.md
├── AGENTS.md
└── paimeng-ai-code-agent/
    ├── AGENTS.md
    └── docs/adr/
        ├── 0001-single-writer-authority.md
        ├── 0002-immutable-delivery.md
        └── 0003-sdk-as-engine.md
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids (for example "App" / "Generation" / "Input", not "project" / "task" / "message").

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (SDK as engine), but worth reopening because…_
