# pi-durable Postgres storage spike

Phase 1 of the "Postgres + Pi Durable" migration: a `Storage` backend for
`@earendil-works/pi-durable` implemented on Postgres, verified against the
framework's official conformance suite and the spike's three end-to-end
experiments (real conversation, compaction, `kill -9` resume).

- `src/pg-storage.ts` — the backend. A port of the framework's own
  `SqliteStorage` reference onto Postgres: record tables keyed by BIGINT IDs, a
  commit sequence, fork-aware entry scans, document incarnations with JSONB
  content and chord-delta revisions. One pinned connection behind a serial queue
  plus a session advisory lock enforce the single-writer contract.
- `test/conformance.test.ts` — runs `registerStorageConformance()` (24 cases)
  plus an advisory-lock exclusivity check.
- `src/harness.ts`, `experiments/*.ts` — the same three experiments as the
  SQLite spike, on Postgres, plus two client-lifecycle experiments:
  `05-disconnect.ts` (an SSE client hard-drops its TCP connection mid-tool and
  the run must finish anyway) and `06-crash-disconnect.ts` (a client is still
  attached when the whole process is SIGKILLed; a restart on the same storage
  must resume and settle).
- `pg.sh` — start/stop a disposable Postgres 16 on `127.0.0.1:55432`.
- `evidence/` — captured output of every run.

## Reproduce

```bash
./pg.sh start                 # disposable Postgres on 127.0.0.1:55432
npm install
npm run test:conformance   # 24 official cases + exclusivity
npx tsc --noEmit              # type check
./run.sh experiments/01-basic.ts
./run.sh experiments/02-compaction.ts
./run.sh experiments/03-crash-resume.ts crash-tool   && ./run.sh experiments/03-crash-resume.ts resume-tool
./run.sh experiments/03-crash-resume.ts crash-model  && ./run.sh experiments/03-crash-resume.ts resume-model
./run.sh experiments/03-crash-resume.ts crash-safe   && ./run.sh experiments/03-crash-resume.ts resume-safe
./run.sh experiments/05-disconnect.ts
./run.sh experiments/06-crash-disconnect.ts crash    && ./run.sh experiments/06-crash-disconnect.ts resume
./pg.sh stop
```

`run.sh` reads `baseUrl`/`apiKey`/`modelId` for the machine's `oc-go` provider
from `~/.pi/agent/models.json` and exports them only into the child process.
Override with `SPIKE_BASE_URL` / `SPIKE_API_KEY` / `SPIKE_MODEL`; point the
backend elsewhere with `DURABLE_PG_URL`.
