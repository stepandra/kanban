# Read-only Review submissions

Tasks that produce an audit instead of repository changes must opt into `deliverableKind=read_only_report`. The worker writes a bounded Markdown report outside the repository and submits it with:

```text
kanban task submit --task-id <id> --project-path <project> --report-file <outside-repository-report.md>
```

Submission fails closed unless the task workspace exists and its Git or jj receipt is clean, conflict-free, non-divergent, and fenced to the current task generation and execution attempt. Existing Review cards can attach their first durable submission when they have no historical execution attempt.

## Acceptance authority

Per-task read-only acceptance is fail-closed. The compatibility CLI command `task accept-read-only` exits nonzero without mutating the board, and the browser exposes no acceptance mutation. A submitted report remains in Review with no acceptance evidence.

The Amp `kanban_tasks` action remains `accept_read_only`. It receives Amp's authenticated current thread context, but refuses before launching Kanban because that context provides no actor capability Kanban can verify. A thread ID, including the exact immutable origin copied from `task list` or the card, is provenance rather than authentication. Browser fields, ordinary environment markers, prompt instructions, hidden command names, and Kanban's CLI-wide internal bearer are likewise not Architect authority.

The exact missing typed primitive is an opaque Amp-issued actor capability bound to the authenticated current tool invocation, thread, acceptance action, and Kanban audience, together with a Kanban-side verifier or Architect-only channel that consumes it. The current Amp/Kanban types provide a thread ID but no such capability. Kanban does not invent a replacement authentication framework here.

Any future authenticated acceptance channel must still bind the exact immutable Amp origin and re-verify the current task generation, execution attempt, report digest, clean receipt, VCS identity, exact parents, and live task workspace before one atomic acceptance transition. Those integrity checks do not substitute for actor authority.

## Migrating an existing read-only Review card

For a legacy card such as `6f7a6`, update it to `read_only_report` only if changing the task generation is acceptable, ensure its task workspace exists and is clean, then submit a bounded report with `--report-file`. If the card is already in Review and has no submission, that first valid submission is allowed with a legacy null attempt. It then remains in Review until a genuine authenticated acceptance channel exists. Cards without Amp origin also remain fail-closed and must be recreated or deliberately migrated with valid provenance before any future acceptance.
