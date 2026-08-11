# Kanban Tracks projection for tldraw Offline

Status: accepted for Phase 1; product role expanded 2026-08-11
Date: 2026-07-31

## Context

Kanban needs a zoomed-out operational picture by delivery track, while tldraw
Offline is the shared spatial planning surface. Copying task state into a
canvas would create two workflow authorities. Exposing repository paths,
architect thread IDs, credentials, or write endpoints to canvas metadata would
also violate the existing Amp Architect and worker boundaries.

## Decision

Kanban remains authoritative for:

- track identity, label, order, and archive state;
- milestone identity, definition of done, state, order, and scope revision;
- the one primary track and milestone assigned to a task;
- optional task scope weight;
- task lifecycle columns and dependency edges.

Kanban publishes `kanban-tracks-projection/v1`, a revisioned read-only
projection keyed by an opaque `projectRef`. Progress is accepted scope weight
divided by total active-milestone scope weight. When no explicit weights exist,
the projection reports count-based progress; when no scope exists, it reports
`Scope not set` instead of `0%`. Backlog, in-progress, and Review remain visible
as pipeline counts and earn no completion credit.

tldraw Offline may materialize this projection as native `timeline-lane` and
`milestone` artifacts plus bound cross-track blocker arrows. Each projected
shape retains only:

- opaque `projectRef`;
- stable track or milestone ID;
- snapshot revision;
- last synchronization timestamp;
- current or orphaned projection state.

Refresh preserves user layout and styling. New milestones are added to their
lane. References removed from the newest projection are marked orphaned and
are never silently deleted.

## Boundary

The provider has no Kanban mutation route. A canvas edit cannot change a task,
milestone, dependency, progress value, or acceptance state. Proposed changes
return to Amp Architect as human-visible canvas context; Amp may then issue an
explicit typed Kanban mutation after confirmation. The next projection is the
only way that change returns to the canvas.

Amp thread IDs, task prompts, repository paths, credentials, runtime tokens,
and full board state do not enter canvas metadata. The loopback bridge accepts
only unauthenticated loopback Kanban origins and proxies the two registered
read endpoints. The upstream runtime stays unaware of tldraw; the tldraw
bridge separately requires its existing resident capability, including for
opaque Offline origins.

## Phase 1 delivery

Kanban includes a native read-only Tracks screen backed by the same projection.
It shows track and milestone progress, scoped task state, unassigned work, and
cross-track blockers. Tasks navigate to Kanban detail, and linked workspaces
navigate to their change in the jj graph. The screen exposes no authoring or
workflow mutation controls.

For compatibility with the current board schema, Phase 1 maps the legacy
`trash`/Done column to accepted progress. This is an explicit transitional
approximation, not an acceptance receipt.

## Deferred

- Track and milestone authoring UI inside Kanban.
- Typed Amp Architect mutations for track/milestone assignment.
- Task expansion on canvas; Phase 1 materializes only tracks, milestones,
  pipeline summaries, unassigned scope, and cross-track blockers.
- Receipt-backed acceptance progress replacing the legacy `trash`/Done
  approximation.

## 2026-08-11 target expansion

Tracks is now the accepted primary browser place for cross-project delivery and
operations, not only a project-scoped Phase 1 screen. It will roll up remote
task executions, immutable Review candidates, and QA campaigns in addition to
the existing milestone scope, progress, unassigned work, and cross-track
blockers.

A QA campaign is not a track or milestone. It freezes an explicit candidate
set and may span several tracks or milestones inside one Kanban project and one
repository. Global Tracks aggregates those repository-local campaigns; it does
not turn one campaign into a cross-repository transaction. Tracks projects each
campaign relationship back into affected scope while campaign membership and
acceptance remain authoritative Kanban records. See
`2026-08-11-grok-build-workers-and-qa-campaigns.md`.
