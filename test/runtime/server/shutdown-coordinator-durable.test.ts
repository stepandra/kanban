import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { shutdownRuntimeServer } from "../../../src/server/shutdown-coordinator";
import { getTaskWorkspacesHomePath, loadWorkspaceState, saveWorkspaceState } from "../../../src/state/workspace-state";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import {
	getWorkspaceFolderLabelForWorktreePath,
	normalizeTaskIdForWorktreePath,
} from "../../../src/workspace/task-worktree-path";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-durable-shutdown-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

// Workspace state paths are canonicalized (realpath) when registered, so
// tests must canonicalize too — on macOS the temp dir lives under the /var
// symlink and would otherwise miss the managed-workspace lookup.
function createProject(sandboxRoot: string, name: string): string {
	const projectPath = join(sandboxRoot, name);
	mkdirSync(projectPath, { recursive: true });
	initGitRepository(projectPath);
	return realpathSync(projectPath);
}

function createCard(taskId: string) {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard(taskIds: string[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: taskIds.map((taskId) => createCard(taskId)) },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createSession(taskId: string, durableSessionName: string | null): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "codex",
		workspacePath: `/tmp/${taskId}`,
		pid: 1234,
		startedAt: Date.now() - 1_000,
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		durableSessionName,
	};
}

async function seedProject(projectPath: string, sessions: Record<string, RuntimeTaskSessionSummary>): Promise<void> {
	const initial = await loadWorkspaceState(projectPath);
	await saveWorkspaceState(projectPath, {
		board: createBoard(Object.keys(sessions)),
		sessions,
		expectedRevision: initial.revision,
	});
}

function createTaskWorktreeDir(repoPath: string, taskId: string): string {
	const worktreePath = join(
		getTaskWorkspacesHomePath(),
		normalizeTaskIdForWorktreePath(taskId),
		getWorkspaceFolderLabelForWorktreePath(repoPath),
	);
	mkdirSync(worktreePath, { recursive: true });
	writeFileSync(join(worktreePath, "marker.txt"), taskId);
	return worktreePath;
}

describe.sequential("shutdown coordinator durable-session guard", () => {
	it("never cleans up a worktree whose durable zmx session survived a runtime restart", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-durable-shutdown-");
			try {
				const projectPath = createProject(sandboxRoot, "project");
				const durableSessionName = "kanban.project.codex.durable-task.0123456789ab";
				const persistedSessions: Record<string, RuntimeTaskSessionSummary> = {
					"durable-task": createSession("durable-task", durableSessionName),
					"plain-task": createSession("plain-task", null),
				};
				await seedProject(projectPath, persistedSessions);
				const durableWorktreePath = createTaskWorktreeDir(projectPath, "durable-task");
				const plainWorktreePath = createTaskWorktreeDir(projectPath, "plain-task");

				// Simulate a runtime restart: a fresh manager rehydrates purely from
				// the persisted record, with zmx reporting the durable session alive.
				const terminalManager = new TerminalSessionManager({
					zmxControl: {
						listSessionNames: async () => [durableSessionName],
						killSession: async () => {},
					},
					warn: () => {},
				});
				terminalManager.hydrateFromRecord(persistedSessions);
				await terminalManager.reconcileDurableSessions();
				expect(terminalManager.isDurableTaskSession("durable-task")).toBe(true);

				let didCloseRuntimeServer = false;
				await shutdownRuntimeServer({
					workspaceRegistry: {
						listManagedWorkspaces: () => [
							{
								workspaceId: "project",
								workspacePath: projectPath,
								terminalManager,
							},
						],
					},
					warn: () => {},
					closeRuntimeServer: async () => {
						didCloseRuntimeServer = true;
					},
				});

				expect(didCloseRuntimeServer).toBe(true);

				const after = await loadWorkspaceState(projectPath);
				const inProgress = after.board.columns.find((column) => column.id === "in_progress")?.cards ?? [];
				const trash = after.board.columns.find((column) => column.id === "trash")?.cards ?? [];

				// The durable task is left alone: not trashed, not interrupted, and
				// its worktree is still on disk because its zmx agent is alive.
				expect(inProgress.map((card) => card.id)).toEqual(["durable-task"]);
				expect(trash.map((card) => card.id)).toEqual(["plain-task"]);
				expect(after.sessions["durable-task"]?.state).toBe("running");
				expect(after.sessions["durable-task"]?.durableSessionName).toBe(durableSessionName);
				expect(after.sessions["plain-task"]?.state).toBe("interrupted");
				expect(existsSync(durableWorktreePath)).toBe(true);
				expect(existsSync(plainWorktreePath)).toBe(false);
			} finally {
				cleanup();
			}
		});
	}, 30_000);

	it("keeps durable tasks of indexed workspaces without a live terminal manager", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-durable-shutdown-indexed-");
			try {
				const projectPath = createProject(sandboxRoot, "indexed-project");
				const durableSessionName = "kanban.indexed-project.codex.durable-task.0123456789ab";
				// Seeding registers the project in the workspace index under the
				// temporary HOME, but no terminal manager is ever loaded for it.
				await seedProject(projectPath, {
					"durable-task": createSession("durable-task", durableSessionName),
					"plain-task": createSession("plain-task", null),
				});
				const durableWorktreePath = createTaskWorktreeDir(projectPath, "durable-task");
				const plainWorktreePath = createTaskWorktreeDir(projectPath, "plain-task");

				await shutdownRuntimeServer({
					workspaceRegistry: {
						listManagedWorkspaces: () => [],
					},
					warn: () => {},
					closeRuntimeServer: async () => {},
				});

				const after = await loadWorkspaceState(projectPath);
				const inProgress = after.board.columns.find((column) => column.id === "in_progress")?.cards ?? [];
				const trash = after.board.columns.find((column) => column.id === "trash")?.cards ?? [];
				expect(inProgress.map((card) => card.id)).toEqual(["durable-task"]);
				expect(trash.map((card) => card.id)).toEqual(["plain-task"]);
				expect(after.sessions["durable-task"]?.state).toBe("running");
				expect(after.sessions["plain-task"]?.state).toBe("interrupted");
				expect(existsSync(durableWorktreePath)).toBe(true);
				expect(existsSync(plainWorktreePath)).toBe(false);
			} finally {
				cleanup();
			}
		});
	}, 30_000);
});
