# Review acceptance

Kanban tasks enter Review through `kanban task submit`. Tasks that produce an audit instead of repository changes must opt into `deliverableKind=read_only_report` and submit a bounded Markdown report outside the repository:

```text
kanban task submit --task-id <id> --project-path <project> --report-file <outside-repository-report.md>
```

Read-only submission fails closed unless the exact task workspace exists and its Git or jj receipt is clean, conflict-free, non-divergent, and fenced to the current task generation and execution attempt. Existing Review cards can attach their first durable submission when they have no historical execution attempt.

## Local acceptance authority

The selected local single-user trust boundary is `kanban task accept` invoked by the local OS user. The installed Amp `kanban_tasks` plugin is the normal caller: its first-class `action="accept"` operation supplies the current `PluginToolContext` thread ID and invokes:

```text
kanban task accept --task-id <id> --origin-amp-thread-id <current-thread> --project-path <project>
```

`accept_read_only` and `task accept-read-only` remain compatibility aliases. They use the same acceptance path and do not grant a weaker read-only-only authority.

Kanban requires the supplied thread ID to match the task's exact immutable `origin.kind="amp_architect"` thread. A wrong or missing origin remains in Review. Direct CLI use by the same local OS user has the same authority by design; there is no separate caller-authentication mechanism and the thread ID is not a portable bearer token.

For a `change` deliverable, acceptance re-resolves the exact task workspace and verifies the current task generation, execution attempt, origin thread, base ref, VCS mode and identity, state digest, and absence of conflicts. It then atomically stores typed `verified_local_workspace` evidence and archives the task. The local workspace may contain the reviewed changes; acceptance does not push or require a remote ref.

For a `read_only_report` deliverable, acceptance also requires the immutable Review submission. Kanban recomputes the report digest, requires the exact submitted workspace path and base identity, re-verifies the clean receipt and VCS identity, and rejects any changed receipt. It then atomically stores `verified_no_change_report` evidence and archives the task.

Both paths reject stale generation or execution attempt, a missing task workspace, a missing read-only submission, conflicts, a changed workspace state, or a mismatched origin thread. Successful acceptance removes dependency edges through the existing board semantics, allowing waiting dependants to start. Acceptance does not stop the durable worker session; session lifecycle remains a separate exact-attempt operation.

The browser remains unable to accept Review work through whole-board snapshot saves or ordinary card movement. Environment markers, internal bearer values, hidden commands, and prompt instructions are not acceptance authority.
