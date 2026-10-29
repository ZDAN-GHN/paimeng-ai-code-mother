# Publish immutable versions and deliveries

- Status: accepted
- Date: 2026-10-29

## Context

Preview, download, deployment, and version restore previously read a mutable shared workspace or its HEAD. Different consumers could observe different source states, and a visible preview could exist without a corresponding version. Partial publish and rollback made "what is currently live" ambiguous.

## Decision

A Version is built from a sealed source snapshot. An accepted Version has one immutable Delivery; Publish atomically records the Version, Delivery, preview pointer, draft baseline, and Generation completion. Preview, download, and Deployment resolve through the same Delivery, never through a live workspace after the first publish. Legacy apps may materialize a Delivery on demand, but the platform does not fabricate a Version row for them.

## Alternatives considered

- Point preview at the workspace: cheap, but edits, builds, and downloads can observe different states.
- Build artifacts lazily on read: fewer writes, but makes availability and version consistency depend on the read path.
- Keep a mutable `dist`: simpler publishing, but replacement is not atomic and old pages can mix assets.

## Consequences

- Deliveries consume storage and must be retained while referenced by preview, deployment, or an active operation.
- Restoring a historical Version switches the existing Delivery and does not create a new Version.
- A failed Deployment does not change the preview or create a half-published Version.

Source: [archived harness-reliability plan](../plans/archive/harness-reliability.md).
