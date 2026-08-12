import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { RuntimeBoardData } from "../../src/core/api-contract";
import { loadWorkspaceState, mutateWorkspaceState } from "../../src/state/workspace-state";
import { verifyReadOnlyReviewForAcceptance } from "../../src/workspace/read-only-review";
import { inspectReviewWorkspace } from "../../src/workspace/review-workspace-receipt";
import { ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { createTempDir } from "../utilities/temp-dir";

function runJj(cwd: string, args: string[]): string {
	const result = spawnSync("jj", ["--no-pager", "--color=never", ...args], {
		cwd,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"));
	}
	return result.stdout.trim();
}

function initializeJjRepo(cwd: string): void {
	const result = spawnSync("jj", ["git", "init"], { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"));
	}
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Kanban Test",
			GIT_AUTHOR_EMAIL: "kanban@example.invalid",
			GIT_COMMITTER_NAME: "Kanban Test",
			GIT_COMMITTER_EMAIL: "kanban@example.invalid",
		},
	});
	if (result.status !== 0) throw new Error([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"));
	return result.stdout.trim();
}

const jjIt = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0 ? it : it.skip;

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const home = createTempDir("kanban-review-verifier-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousDataHome = process.env.XDG_DATA_HOME;
	process.env.HOME = home.path;
	process.env.USERPROFILE = home.path;
	process.env.XDG_DATA_HOME = join(home.path, ".local", "share");
	try {
		return await run();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousDataHome;
		home.cleanup();
	}
}

describe.sequential("Review workspace receipt integration", () => {
	jjIt(
		"returns JJ changes and a stable clean receipt relative to the exact @ parents",
		async () => {
			const sandbox = createTempDir("kanban-review-receipt-jj-");
			try {
				const repoPath = join(realpathSync(sandbox.path), "repo");
				mkdirSync(repoPath, { recursive: true });
				initializeJjRepo(repoPath);
				writeFileSync(join(repoPath, "README.md"), "base\n", "utf8");
				runJj(repoPath, ["describe", "-m", "base"]);
				const baseCommit = runJj(repoPath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
				const taskPath = join(sandbox.path, "task");
				runJj(repoPath, ["workspace", "add", "--name", "task", "-r", "@", taskPath]);

				writeFileSync(join(taskPath, "README.md"), "changed\n", "utf8");
				writeFileSync(join(taskPath, "new.txt"), "new\n", "utf8");
				const changed = await inspectReviewWorkspace({ cwd: taskPath, baseRef: baseCommit });
				expect(changed.vcs).toBe("jj");
				expect(changed.changes.files.map((file) => [file.path, file.status])).toHaveLength(2);
				expect(changed.changes.files.map((file) => [file.path, file.status])).toEqual(
					expect.arrayContaining([
						["README.md", "modified"],
						["new.txt", "added"],
					]),
				);
				expect(changed.receipt.clean).toBe(false);
				const modifiedFile = changed.changes.files.find((file) => file.path === "README.md");
				expect(modifiedFile).toMatchObject({
					status: "modified",
					oldText: "base\n",
					newText: "changed\n",
					additions: 1,
					deletions: 1,
				});
				const addedFile = changed.changes.files.find((file) => file.path === "new.txt");
				expect(addedFile).toMatchObject({ status: "added", oldText: null, newText: "new\n" });
				if (changed.receipt.vcs !== "jj") throw new Error("Expected jj receipt");
				expect(changed.receipt.parentCommitIds).toEqual([baseCommit]);

				runJj(taskPath, ["restore"]);
				const clean = await inspectReviewWorkspace({ cwd: taskPath, baseRef: baseCommit });
				expect(clean.changes.files).toEqual([]);
				expect(clean.receipt).toMatchObject({ vcs: "jj", clean: true, hasConflicts: false, divergent: false });
				const repeated = await inspectReviewWorkspace({ cwd: taskPath, baseRef: baseCommit });
				expect(repeated.receipt.stateDigest).toBe(clean.receipt.stateDigest);
			} finally {
				sandbox.cleanup();
			}
		},
		60_000,
	);

	it("covers Git tracked and untracked state against the exact HEAD/base identity", async () => {
		const sandbox = createTempDir("kanban-review-receipt-git-");
		try {
			const repoPath = join(realpathSync(sandbox.path), "repo");
			mkdirSync(repoPath, { recursive: true });
			runGit(repoPath, ["init", "-q"]);
			writeFileSync(join(repoPath, "README.md"), "base\n", "utf8");
			runGit(repoPath, ["add", "README.md"]);
			runGit(repoPath, ["commit", "-qm", "base"]);
			const baseCommit = runGit(repoPath, ["rev-parse", "HEAD"]);

			writeFileSync(join(repoPath, "README.md"), "changed\n", "utf8");
			writeFileSync(join(repoPath, "untracked.txt"), "new\n", "utf8");
			const dirty = await inspectReviewWorkspace({ cwd: repoPath, baseRef: baseCommit });
			expect(dirty.changes.files.map((file) => file.status)).toEqual(
				expect.arrayContaining(["modified", "untracked"]),
			);
			expect(dirty.receipt).toMatchObject({
				vcs: "git",
				clean: false,
				hasUntracked: true,
				headCommit: baseCommit,
				baseCommit,
			});

			writeFileSync(join(repoPath, "README.md"), "base\n", "utf8");
			unlinkSync(join(repoPath, "untracked.txt"));
			const clean = await inspectReviewWorkspace({ cwd: repoPath, baseRef: baseCommit });
			expect(clean.changes.files).toEqual([]);
			expect(clean.receipt).toMatchObject({ vcs: "git", clean: true, hasUntracked: false });
		} finally {
			sandbox.cleanup();
		}
	}, 30_000);

	it("re-verifies every acceptance fence without persisting an acceptance transition", async () => {
		await withTemporaryHome(async () => {
			const sandbox = createTempDir("kanban-read-only-acceptance-verifier-");
			try {
				const repoPath = join(realpathSync(sandbox.path), "repo");
				mkdirSync(repoPath, { recursive: true });
				runGit(repoPath, ["init", "-q"]);
				writeFileSync(join(repoPath, "README.md"), "base\n", "utf8");
				runGit(repoPath, ["add", "README.md"]);
				runGit(repoPath, ["commit", "-qm", "base"]);
				const baseCommit = runGit(repoPath, ["rev-parse", "HEAD"]);
				const taskId = "read-only-verifier";
				const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId, baseRef: baseCommit });
				if (!ensured.ok || !ensured.path) throw new Error(ensured.error ?? "Expected task workspace.");
				const inspected = await inspectReviewWorkspace({ cwd: ensured.path, baseRef: baseCommit });
				const reportMarkdown = "# Audit\n\nNo repository changes are required.\n";
				const reportDigest = createHash("sha256").update(reportMarkdown).digest("hex");
				const board: RuntimeBoardData = {
					columns: [
						{ id: "backlog", title: "Backlog", cards: [] },
						{ id: "in_progress", title: "In Progress", cards: [] },
						{
							id: "review",
							title: "Review",
							cards: [
								{
									id: taskId,
									title: "Read-only verifier",
									prompt: "Audit without changes",
									startInPlanMode: false,
									baseRef: baseCommit,
									generation: 3,
									execution: { attemptId: "attempt-3", generation: 3, queuedAt: 1 },
									origin: { kind: "amp_architect", threadId: "T-architect-verifier" },
									deliverableKind: "read_only_report",
									submission: {
										taskId,
										generation: 3,
										executionAttemptId: "attempt-3",
										deliverableKind: "read_only_report",
										reportMarkdown,
										reportDigest,
										submittedAt: 2,
										workspace: { taskId, path: ensured.path, vcs: "git", baseRef: baseCommit },
										receipt: inspected.receipt,
									},
									createdAt: 1,
									updatedAt: 2,
								},
							],
						},
						{ id: "trash", title: "Done", cards: [] },
					],
					dependencies: [],
				};
				await mutateWorkspaceState(repoPath, () => ({ board, value: null }));

				const verified = await verifyReadOnlyReviewForAcceptance({
					workspaceRepoPath: repoPath,
					taskId,
				});
				expect(verified.evidence).toMatchObject({
					taskId,
					generation: 3,
					executionAttemptId: "attempt-3",
					reportDigest,
					architectThreadId: "T-architect-verifier",
					receipt: inspected.receipt,
				});
				const persisted = await loadWorkspaceState(repoPath);
				expect(persisted.board.columns.find((column) => column.id === "review")?.cards[0]?.id).toBe(taskId);
				expect(persisted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
				expect(verified.task.acceptanceEvidence).toBeUndefined();

				writeFileSync(join(ensured.path, "dirty.txt"), "dirty\n", "utf8");
				await expect(
					verifyReadOnlyReviewForAcceptance({
						workspaceRepoPath: repoPath,
						taskId,
					}),
				).rejects.toThrow("verified-clean no-change state");
				unlinkSync(join(ensured.path, "dirty.txt"));
				await mutateWorkspaceState(repoPath, (state) => {
					const staleBoard = structuredClone(state.board);
					const task = staleBoard.columns.find((column) => column.id === "review")?.cards[0];
					if (!task?.execution) throw new Error("Expected current Review execution fence.");
					task.execution = { ...task.execution, attemptId: "attempt-stale" };
					return { board: staleBoard, value: null };
				});
				await expect(
					verifyReadOnlyReviewForAcceptance({
						workspaceRepoPath: repoPath,
						taskId,
					}),
				).rejects.toThrow("stale for the current task generation or attempt");
			} finally {
				sandbox.cleanup();
			}
		});
	}, 30_000);
});
