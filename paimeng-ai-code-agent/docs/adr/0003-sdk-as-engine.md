# Keep pi-durable as the engine, with the product control plane outside it

- Status: accepted
- Date: 2026-10-29

## Context

pi-durable 1.4.0 supplies the model/tool loop, task scheduling, sleeping, parked tasks, and storage. The product also needs input watermarks, asks, budgets, effect admission, publish transactions, and legacy migration. Forking the SDK would make each upgrade a merge of two evolving state machines.

## Decision

Upgrade the three direct SDK packages to exact 1.4.0 versions and keep the SDK as the execution engine. The product owns authority, durable inputs, attempts, effect admission, delivery, and recovery around it. The adapter uses the SDK's checkpoint and failure hooks, but does not fork or replace the task loop. SDK storage and product storage migrate independently; an older adapter must refuse newer schema instead of opening it.

## Alternatives considered

- Fork pi-durable and own the loop: gives direct control, but permanently couples the product to one SDK revision.
- Reimplement the agent loop: removes SDK constraints, but recreates scheduling, sleeping, retry, and telemetry that are already tested.
- Let the SDK own product state: fewer adapters, but mixes external effects and user-visible publishing with SDK scheduling.

## Consequences

- SDK upgrades require contract and storage-conformance tests.
- Ordinary provider/SDK retries remain enabled in 1.4.0; product budgets and the persistent deadline still bound the work. This is a deliberate deviation from the early plan, not an unexamined default.
- Parked SDK tasks are diagnosed, not automatically retried. Product generation closes as failed/interrupted and keeps its sealed draft.

Source: [archived harness-reliability plan](../plans/archive/harness-reliability.md).
