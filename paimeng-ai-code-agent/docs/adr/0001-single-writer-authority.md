# Single-writer authority with isolated executions

- Status: accepted
- Date: 2026-10-29

## Context

The Next server authenticates and forwards events, while generation runs in a long-lived harness. Generation must survive browser disconnects and harness restarts without letting two workers write the same App. The old generation lease and shared workspace allowed read paths to take over work, and did not make the owner of an App's write state explicit.

## Decision

Every App has one durable authority record with a monotonic epoch and an optional holder. A Generation runs in one Execution with its own directory, Execution conversation, and write token. A control transaction locks App, authority, Generation, and Attempt in that order; expiry uses the database clock. Recovery revokes unfinished editing work, reconciles checking/publishing work, and only a higher epoch can replace an old owner. All write paths pass the same authority check.

## Alternatives considered

- Let Next write directly: simpler routing, but no durable owner and no way to survive a browser or process restart.
- Lease one Generation at a time: common case works, but an App-level actor can change while older work is still draining.
- Allow multiple harness writers with row locks alone: increases throughput, but makes cross-process cancellation and recovery ambiguous.

## Consequences

- The first version is single-host and single-harness-writer. Cross-machine scheduling is out of scope.
- `generation_lease` remains only for old tests and old data; production generation authority is the authority record.
- Every new write path must acquire the same authority. Adding a bypass is an architecture change, not a local shortcut.

Source: [archived harness-reliability plan](../plans/archive/harness-reliability.md).
