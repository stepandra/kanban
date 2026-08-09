import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeBoardData } from "../../src/core/api-contract";
import { saveWorkspaceState } from "../../src/state/workspace-state";
import { inspectJjRepositoryHealth } from "../../src/workspace/jj-doctor";
import { ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { createTempDir } from "../utilities/temp-dir";

function runJj(cwd: string, args: string[]): string {
	const result = spawnSync("jj", ["--no-pager", "--color=never", "-R", cwd, ...args], { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			[`jj ${args.join(" ")} failed`, result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
		);
	}
	return result.stdout.trim();
}

const jjIt = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0 ? it : it.skip;

function initRepo(repoPath: string): void {
	mkdirSync(repoPath, { recursive: true });
	const result = spawnSync("jj", ["git", "init"], { cwd: repoPath, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr.trim());
	runJj(repoPath, ["config", "set", "--repo", "user.name", "Kanban Test"]);
	runJj(repoPath, ["config", "set", "--repo", "user.email", "kanban-test@example.com"]);
	writeFileSync(join(repoPath, "README.md"), "hello\n");
	runJj(repoPath, ["describe", "-m", "initial"]);
}

function operationState(repoPath: string): { head: string; count: number } {
	const output = runJj(repoPath, ["--ignore-working-copy", "op", "log", "--no-graph", "-T", 'self.id() ++ "\\n"']);
	const operations = output.split("\n").filter(Boolean);
	return { head: operations[0] ?? "", count: operations.length };
}

function boardCard(id: string): RuntimeBoardData["columns"][number]["cards"][number] {
	return { id, title: id, prompt: id, startInPlanMode: false, baseRef: "@", createdAt: 1, updatedAt: 1 };
}

function buildBoard(placement: { in_progress?: string[]; trash?: string[] }): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: (placement.in_progress ?? []).map(boardCard) },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: (placement.trash ?? []).map(boardCard) },
		],
		dependencies: [],
	};
}

describe.sequential("jj doctor integration", () => {
	let home: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;
	let previousXdgDataHome: string | undefined;

	beforeEach(() => {
		home = createTempDir("kanban-home-");
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		previousXdgDataHome = process.env.XDG_DATA_HOME;
		process.env.HOME = home.path;
		process.env.USERPROFILE = home.path;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousXdgDataHome;
		home.cleanup();
	});

	jjIt("returns a structured failure outside a jj repository", async () => {
		const sandbox = createTempDir("kanban-jj-doctor-nonjj-");
		try {
			const report = await inspectJjRepositoryHealth({ cwd: sandbox.path });
			expect(report.ok).toBe(false);
			expect(report.vcs).toBeNull();
			expect(report.reason).toContain("No jj repository");
		} finally {
			sandbox.cleanup();
		}
	});

	jjIt("inventories task workspaces and reconciles active and completed cards", async () => {
		const sandbox = createTempDir("kanban-jj-doctor-multi-");
		try {
			const repoPath = join(sandbox.path, "repo");
			initRepo(repoPath);
			await saveWorkspaceState(repoPath, {
				board: buildBoard({ in_progress: ["task-active"], trash: ["task-done"] }),
				sessions: {},
			});
			expect(
				(await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId: "task-active", baseRef: "@" })).ok,
			).toBe(true);
			expect((await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId: "task-done", baseRef: "@" })).ok).toBe(
				true,
			);
			const report = await inspectJjRepositoryHealth({ cwd: repoPath });
			expect(report.ok).toBe(true);
			expect(report.healthy).toBe(true);
			expect(report.boardConnected).toBe(true);
			expect(report.workspaces).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "kanban-task-active",
						boardColumn: "in_progress",
						classification: "active",
					}),
					expect.objectContaining({ name: "kanban-task-done", boardColumn: "trash", classification: "completed" }),
				]),
			);
			expect(report.issues).toEqual([]);
			expect(report.gaps.some((gap) => gap.includes("staleness"))).toBe(true);
		} finally {
			sandbox.cleanup();
		}
	});

	jjIt("flags a registered task workspace whose path is missing", async () => {
		const sandbox = createTempDir("kanban-jj-doctor-missing-");
		try {
			const repoPath = join(sandbox.path, "repo");
			initRepo(repoPath);
			const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId: "task-missing", baseRef: "@" });
			expect(ensured.ok).toBe(true);
			if (!ensured.ok || !ensured.path) throw new Error("Task workspace was not created");
			rmSync(ensured.path, { recursive: true, force: true });
			const report = await inspectJjRepositoryHealth({ cwd: repoPath });
			expect(report.workspaces).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "kanban-task-missing", pathExists: false, classification: "orphaned" }),
				]),
			);
			expect(report.issues).toEqual(
				expect.arrayContaining([expect.objectContaining({ kind: "missing-path", taskId: "task-missing" })]),
			);
			expect(report.healthy).toBe(false);
		} finally {
			sandbox.cleanup();
		}
	});

	jjIt("surfaces a conflicted working-copy commit", async () => {
		const sandbox = createTempDir("kanban-jj-doctor-conflict-");
		try {
			const repoPath = join(sandbox.path, "repo");
			initRepo(repoPath);
			writeFileSync(join(repoPath, "f.txt"), "base\n");
			runJj(repoPath, ["describe", "-m", "P"]);
			const parent = runJj(repoPath, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "change_id"]);
			runJj(repoPath, ["new", parent, "-m", "A"]);
			writeFileSync(join(repoPath, "f.txt"), "a\n");
			const a = runJj(repoPath, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "change_id"]);
			runJj(repoPath, ["new", parent, "-m", "B"]);
			writeFileSync(join(repoPath, "f.txt"), "b\n");
			const b = runJj(repoPath, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "change_id"]);
			runJj(repoPath, ["new", a, b, "-m", "merge"]);
			const report = await inspectJjRepositoryHealth({ cwd: repoPath });
			expect(report.workspaces).toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "default", conflicted: true })]),
			);
			expect(report.issues.some((issue) => issue.kind === "conflicted")).toBe(true);
			expect(report.healthy).toBe(false);
		} finally {
			sandbox.cleanup();
		}
	});

	jjIt("surfaces a divergent change created with describe --at-op", async () => {
		const sandbox = createTempDir("kanban-jj-doctor-divergent-");
		try {
			const repoPath = join(sandbox.path, "repo");
			initRepo(repoPath);
			const operationId = runJj(repoPath, ["op", "log", "--no-graph", "--limit", "1", "-T", "self.id().short()"]);
			runJj(repoPath, ["describe", "-m", "rewrite-A"]);
			runJj(repoPath, ["describe", "--at-op", operationId, "-m", "rewrite-B"]);
			const report = await inspectJjRepositoryHealth({ cwd: repoPath });
			expect(report.workspaces).toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "default", divergent: true })]),
			);
			expect(report.issues.some((issue) => issue.kind === "divergent")).toBe(true);
			expect(report.healthy).toBe(false);
		} finally {
			sandbox.cleanup();
		}
	});

	jjIt("attributes visible heads only to their owning workspace", async () => {
		const sandbox = createTempDir("kanban-jj-doctor-heads-");
		try {
			const repoPath = join(sandbox.path, "repo");
			initRepo(repoPath);
			const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId: "task-owned", baseRef: "@" });
			if (!ensured.ok || !ensured.path) throw new Error("Task workspace was not created");
			const owned = runJj(ensured.path, [
				"--ignore-working-copy",
				"log",
				"-r",
				"@",
				"--no-graph",
				"-T",
				"commit_id",
			]);
			runJj(repoPath, ["new", "-m", "orphan-head"]);
			writeFileSync(join(repoPath, "orphan.txt"), "orphan\n");
			const orphan = runJj(repoPath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
			runJj(repoPath, ["edit", "@-"]);
			const report = await inspectJjRepositoryHealth({ cwd: repoPath });
			expect(report.heads.find((head) => head.commitId === orphan)?.ownedByWorkspace).toBeNull();
			expect(report.heads.find((head) => head.commitId === owned)?.ownedByWorkspace).toBe("kanban-task-owned");
			expect(report.workspaces.some((workspace) => workspace.commitId === orphan)).toBe(false);
		} finally {
			sandbox.cleanup();
		}
	});

	jjIt("does not create jj operations when inspection is repeated", async () => {
		const sandbox = createTempDir("kanban-jj-doctor-readonly-");
		try {
			const repoPath = join(sandbox.path, "repo");
			initRepo(repoPath);
			const before = operationState(repoPath);
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const report = await inspectJjRepositoryHealth({ cwd: repoPath });
				expect(report.ok).toBe(true);
			}
			const after = operationState(repoPath);
			expect(after.head).toBe(before.head);
			expect(after.count).toBe(before.count);
		} finally {
			sandbox.cleanup();
		}
	});
});
