## npx kanban (Research Preview)

<p align="center">
  <img src="https://github.com/user-attachments/assets/2aa3dcc7-94e3-4076-bcfe-6d0272007cfe" width="100%" />
</p>

A control plane for running many coding tasks in parallel and reviewing their work. Each task card gets its own terminal and retained workspace, while explicit dependencies prevent blocked work from starting early.

> [!WARNING]
> Kanban is a research preview and uses experimental features of CLI agents like bypassing permissions and runtime hooks for more autonomy. We'd love your feedback in #kanban on our [discord](https://discord.gg/cline).

<div align="left">
<table>
<tbody>
<td align="center">
<a href="https://www.npmjs.com/package/kanban" target="_blank">NPM</a>
</td>
<td align="center">
<a href="https://github.com/stepandra/kanban" target="_blank">GitHub</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban/issues" target="_blank">Issues</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop" target="_blank">Feature Requests</a>
</td>
<td align="center">
<a href="https://discord.gg/cline" target="_blank">Discord</a>
</td>
<td align="center">
<a href="https://x.com/cline" target="_blank">@cline</a>
</td>
</tbody>
</table>
</div>

### 1. Open kanban
```bash
# Run directly (no install required)
npx kanban

# Or install globally
npm i -g kanban
kanban
```
Run this from the root of any git repo. Kanban will detect your installed CLI agent and launch a local running webserver in your browser. No account or setup required, it works right out of the box.

### 2. Create tasks
Create a task card manually, or install the Amp plugin once:

```bash
amp plugins add https://raw.githubusercontent.com/stepandra/kanban/main/amp/kanban.ts --auto-update
```

Then ask Amp to add, assign, link, or start Kanban tasks from any thread. Prefer Grok Build for implementation; Claude, Codex, and Kimi remain compatibility harnesses. Amp itself plans and decomposes work rather than running individual tasks. For a dedicated planning thread, run **Kanban: Decompose into tasks** from Amp's command palette. It opens a native Amp `medium` thread rather than embedding another agent runtime in Kanban.

Executors submit completed work to **Review**; they do not accept their own work. Local agents report through Kanban's task hooks. `trash` explicitly discards a task without satisfying dependencies or deleting its workspace. Acceptance is reserved for the owning QA campaign and is currently fail-closed until campaign-scoped receipts are implemented.

### 3. Link and automate
<kbd>⌘</kbd> + click a card to link it to another task. A dependency points from the waiting task to its prerequisite. Waiting tasks stay blocked when prerequisites are discarded; only verified campaign acceptance can satisfy the dependency.

### 4. Start tasks
Hit the play button on a card. Kanban creates an ephemeral worktree just for that task so agents work in parallel without merge conflicts. Under the hood, it also symlinks gitignored files like `node_modules` so you don't have to worry about slow `npm install`s for each copy of your project.

> [!NOTE]
> [Symlinks (symbolic links)](https://en.wikipedia.org/wiki/Symbolic_link) are special "shortcuts" pointing to another file or directory, allowing access to the target from a new location without duplicating data. They work great in this case since you typically don't modify gitignored files in day-to-day work, but for when you do then don't use Kanban.

As agents work, Kanban uses hooks to display the latest message or tool call on each card, so you can monitor hundreds of agents at a glance without opening each one.

### 5. Review changes
Click a card to view the agent's TUI and a diff of all the changes in that worktree. Kanban includes its own checkpointing system so you can also see a diff from the last messages you've sent. Click on lines to leave comments and send them back to the agent.

To easily test and debug your app, create a Script Shortcut in settings. Use a command like `npm run dev` so that all you have to do is hit a play button in the navbar instead of remembering commands or asking your agent to do it.

### 6. Ship it
The owning QA campaign freezes the candidate set, integrates it in one `a1.xxlarge` Amp Orb, fans out production checks, fixes findings in that same Orb, and publishes one verified campaign revision. Per-task workers and Review cards cannot commit, push, or accept themselves.

### 7. Keep track with git interface
Click the branch name in the navbar to open a full git interface to browse commit history, switch branches, fetch, pull, push, and visualize your git all without leaving Kanban. Keep track of everything your agents are doing across branches as work is completed.

---

[Apache 2.0 © 2026 Cline Bot Inc.](./LICENSE)
