# Engineering Docs

This folder is the starting point for engineers working on Kanban itself.

This follows the usual split a small engineering team would want:

- `README.md` explains the product, local setup, and everyday usage.
- `docs/` holds stable onboarding and architecture references for humans.
- `.plan/docs/` holds active plans, handoffs, and deeper change-history context for larger refactors.

If you are new to the codebase, read these in order:

1. [`../README.md`](../README.md) for the product overview and local setup.
2. [`architecture.md`](./architecture.md) for the system map, runtime model, and key file guide.
3. [`jj-doctor.md`](./jj-doctor.md) for the read-only jj workspace health inventory.
4. [`decisions/2026-07-25-kanban-vnext-ownership-and-lifecycle.md`](./decisions/2026-07-25-kanban-vnext-ownership-and-lifecycle.md)
   for the accepted vNext task-generation, ownership, fencing, submission, and promotion boundaries.
5. [`zmx-session-names.md`](./zmx-session-names.md) for the durable zmx session-name contract shared with external tooling.

This `docs/` folder should stand on its own for normal onboarding. Active plans and handoffs may still exist in `.plan/docs`, but a new engineer should not need those to understand the current architecture.

When adding new engineering docs, prefer putting stable explanations here and linking them from this index.
