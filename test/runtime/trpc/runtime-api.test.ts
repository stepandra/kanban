import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type {
	RuntimeBoardColumnId,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";

const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
	buildRuntimeConfigResponse: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const turnCheckpointMocks = vi.hoisted(() => ({
	captureBestEffortTurnCheckpoint: vi.fn(),
}));

const browserMocks = vi.hoisted(() => ({
	openInBrowser: vi.fn(),
}));

const absurdTaskStartMocks = vi.hoisted(() => ({
	enqueueAbsurdTaskStart: vi.fn(),
}));

vi.mock("../../../src/terminal/agent-registry.js", () => ({
	resolveAgentCommand: agentRegistryMocks.resolveAgentCommand,
	buildRuntimeConfigResponse: agentRegistryMocks.buildRuntimeConfigResponse,
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureBestEffortTurnCheckpoint: turnCheckpointMocks.captureBestEffortTurnCheckpoint,
}));

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: browserMocks.openInBrowser,
}));

vi.mock("../../../src/orchestration/absurd-task-start.js", () => ({
	enqueueAbsurdTaskStart: absurdTaskStartMocks.enqueueAbsurdTaskStart,
}));

import { moveTaskToColumn } from "../../../src/core/task-board-mutations";
import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";

function createTestRuntimeApi(
	deps: Omit<
		CreateRuntimeApiDependencies,
		| "getUpdateStatus"
		| "runUpdateNow"
		| "buildWorkspaceStateSnapshot"
		| "mutateWorkspaceState"
		| "broadcastRuntimeWorkspaceStateUpdated"
	> &
		Partial<
			Pick<
				CreateRuntimeApiDependencies,
				| "getUpdateStatus"
				| "runUpdateNow"
				| "buildWorkspaceStateSnapshot"
				| "mutateWorkspaceState"
				| "broadcastRuntimeWorkspaceStateUpdated"
			>
		>,
): RuntimeTrpcContext["runtimeApi"] {
	const buildWorkspaceStateSnapshot =
		deps.buildWorkspaceStateSnapshot ??
		vi.fn(async () => {
			throw new Error("Unexpected workspace state snapshot request.");
		});
	const mutateWorkspaceState: CreateRuntimeApiDependencies["mutateWorkspaceState"] =
		deps.mutateWorkspaceState ??
		(async (_workspacePath, mutate) => {
			const state = await buildWorkspaceStateSnapshot("workspace-1", _workspacePath);
			const mutation = mutate(state);
			const saved = mutation.save !== false;
			return {
				value: mutation.value,
				state: saved
					? {
							...state,
							board: mutation.board,
							sessions: mutation.sessions ?? state.sessions,
							revision: state.revision + 1,
						}
					: state,
				saved,
			};
		});
	return createRuntimeApi({
		...deps,
		buildWorkspaceStateSnapshot,
		mutateWorkspaceState,
		broadcastRuntimeWorkspaceStateUpdated: deps.broadcastRuntimeWorkspaceStateUpdated ?? vi.fn(),
		getUpdateStatus:
			deps.getUpdateStatus ??
			vi.fn(() => ({
				currentVersion: "0.1.0",
				latestVersion: null,
				updateAvailable: false,
				updateTiming: null,
				installCommand: null,
			})),
		runUpdateNow:
			deps.runUpdateNow ??
			vi.fn(async () => ({
				status: "unsupported_installation" as const,
				currentVersion: "0.1.0",
				latestVersion: null,
				message: "On-demand updates are not available in this test runtime.",
			})),
	});
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createRuntimeConfigState(): RuntimeConfigState {
	return {
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		taskTemplates: [],
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
	};
}

function createWorkspaceStateWithTask(input: {
	columnId: RuntimeBoardColumnId;
	generation?: number;
}): RuntimeWorkspaceStateResponse {
	const task = {
		id: "task-1",
		title: "Task",
		prompt: "Continue",
		baseRef: "main",
		generation: input.generation ?? 1,
		createdAt: 1,
		updatedAt: 1,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
	};
	return {
		repoPath: "/tmp/repo",
		statePath: "/tmp/state.json",
		vcs: "jj",
		git: {
			currentBranch: null,
			defaultBranch: "main",
			branches: ["main"],
		},
		board: {
			columns: (["backlog", "in_progress", "review", "trash"] as const).map((columnId) => ({
				id: columnId,
				title: columnId === "trash" ? "Done" : columnId,
				cards: columnId === input.columnId ? [task] : [],
			})),
			dependencies: [],
		},
		sessions: {},
		revision: 1,
	};
}

describe("createRuntimeApi startTaskSession", () => {
	beforeEach(() => {
		agentRegistryMocks.resolveAgentCommand.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureBestEffortTurnCheckpoint.mockReset();
		browserMocks.openInBrowser.mockReset();
		absurdTaskStartMocks.enqueueAbsurdTaskStart.mockReset();
		absurdTaskStartMocks.enqueueAbsurdTaskStart.mockResolvedValue({
			attemptId: "absurd-task-1",
			raw: { task_id: "absurd-task-1" },
		});

		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "claude",
			args: [],
		});
		turnCheckpointMocks.captureBestEffortTurnCheckpoint.mockResolvedValue({
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		});
	});

	it("reuses an existing worktree path before falling back to ensure", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
				executionAttempt: { attemptId: "attempt-1", generation: 2, queuedAt: 10 },
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledTimes(1);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/existing-worktree",
				projectPath: "/tmp/repo",
				executionAttempt: { attemptId: "attempt-1", generation: 2, queuedAt: 10 },
			}),
		);
	});

	it("ensures the worktree when no existing task cwd is available", async () => {
		taskWorktreeMocks.resolveTaskCwd
			.mockRejectedValueOnce(new Error("missing"))
			.mockResolvedValueOnce("/tmp/new-worktree");

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
			},
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenNthCalledWith(1, {
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: false,
		});
		expect(taskWorktreeMocks.resolveTaskCwd).toHaveBeenNthCalledWith(2, {
			cwd: "/tmp/repo",
			taskId: "task-1",
			baseRef: "main",
			ensure: true,
		});
	});

	it("forwards task images to CLI task sessions", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "codex",
			label: "OpenAI Codex",
			command: "codex",
			binary: "codex",
			args: [],
		});

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => {
				const runtimeConfigState = createRuntimeConfigState();
				runtimeConfigState.selectedAgentId = "codex";
				return runtimeConfigState;
			}),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const images = [
			{
				id: "img-1",
				data: Buffer.from("hello").toString("base64"),
				mimeType: "image/png",
				name: "diagram.png",
			},
		];

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				images,
			},
		);

		expect(response.ok).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				images,
			}),
		);
	});

	it("resumes trash-restored sessions with the previously recorded terminal agent", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		agentRegistryMocks.resolveAgentCommand.mockImplementation((config: RuntimeConfigState) => ({
			agentId: config.selectedAgentId,
			label: "Agent",
			command: config.selectedAgentId,
			binary: config.selectedAgentId,
			args: [],
		}));

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary({ agentId: "codex" })),
			applyTurnCheckpoint: vi.fn(),
			getSummary: vi.fn(() => createSummary({ agentId: "codex", state: "idle", pid: null })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Continue task",
				resumeFromTrash: true,
			},
		);

		expect(response.ok).toBe(true);
		expect(agentRegistryMocks.resolveAgentCommand).toHaveBeenCalledWith(
			expect.objectContaining({ selectedAgentId: "codex" }),
		);
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				resumeFromTrash: true,
			}),
		);
		// Trash-restore resumes the existing turn; no new checkpoint is captured.
		expect(turnCheckpointMocks.captureBestEffortTurnCheckpoint).not.toHaveBeenCalled();
	});

	it("captures a best effort turn checkpoint after a fresh session start", async () => {
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		const checkpoint = {
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		};
		turnCheckpointMocks.captureBestEffortTurnCheckpoint.mockResolvedValue(checkpoint);

		const terminalManager = {
			startTaskSession: vi.fn(async () => createSummary()),
			applyTurnCheckpoint: vi.fn(() => createSummary({ latestTurnCheckpoint: checkpoint })),
		};
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.startTaskSession(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				prompt: "Investigate startup freeze",
			},
		);

		expect(response.ok).toBe(true);
		expect(turnCheckpointMocks.captureBestEffortTurnCheckpoint).toHaveBeenCalledWith({
			cwd: "/tmp/existing-worktree",
			taskId: "task-1",
			latestTurnCheckpoint: null,
		});
		expect(terminalManager.applyTurnCheckpoint).toHaveBeenCalledWith("task-1", checkpoint);
	});

	it("runs reset teardown before deleting debug state paths", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [
			join(tempHome, ".cline", "kanban"),
			join(tempHome, ".local", "share", "kanban", "task-workspaces"),
			join(tempHome, ".cline", "worktrees"),
		];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const prepareForStateReset = vi.fn(async () => {
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		});
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			prepareForStateReset,
		});

		try {
			const response = await api.resetAllState(null);

			expect(response.ok).toBe(true);
			expect(prepareForStateReset).toHaveBeenCalledTimes(1);
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(false);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("aborts reset path deletion when teardown fails", async () => {
		const originalHome = process.env.HOME;
		const tempHome = `/tmp/kanban-reset-home-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		process.env.HOME = tempHome;
		mkdirSync(tempHome, { recursive: true });
		const debugPaths = [
			join(tempHome, ".cline", "kanban"),
			join(tempHome, ".local", "share", "kanban", "task-workspaces"),
			join(tempHome, ".cline", "worktrees"),
		];
		for (const path of debugPaths) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "marker.txt"), "present");
		}
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			prepareForStateReset: vi.fn(async () => {
				throw new Error("teardown failed");
			}),
		});

		try {
			await expect(api.resetAllState(null)).rejects.toThrow("teardown failed");
			for (const path of debugPaths) {
				expect(existsSync(path)).toBe(true);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});

describe("createRuntimeApi update handlers", () => {
	beforeEach(() => {
		absurdTaskStartMocks.enqueueAbsurdTaskStart.mockReset();
		absurdTaskStartMocks.enqueueAbsurdTaskStart.mockResolvedValue({
			attemptId: "absurd-task-1",
			raw: { task_id: "absurd-task-1" },
		});
	});

	it("delegates update status to the required dependency", async () => {
		const getUpdateStatus = vi.fn(() => ({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			updateAvailable: true,
			updateTiming: "startup" as const,
			installCommand: "npm install -g kanban@latest",
		}));
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			getUpdateStatus,
		});

		await expect(api.getUpdateStatus(null)).resolves.toEqual({
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			updateAvailable: true,
			updateTiming: "startup",
			installCommand: "npm install -g kanban@latest",
		});
		expect(getUpdateStatus).toHaveBeenCalledTimes(1);
	});

	it("delegates update execution to the required dependency", async () => {
		const runUpdateNow = vi.fn(async () => ({
			status: "updated" as const,
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			message: "Updated Kanban to 0.2.0.",
		}));
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			runUpdateNow,
		});

		await expect(api.runUpdateNow(null)).resolves.toEqual({
			status: "updated",
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			message: "Updated Kanban to 0.2.0.",
		});
		expect(runUpdateNow).toHaveBeenCalledTimes(1);
	});

	it("enqueues browser starts through Absurd with generation and resume intent", async () => {
		let persistedState = createWorkspaceStateWithTask({ columnId: "trash", generation: 4 });
		const mutateWorkspaceState: CreateRuntimeApiDependencies["mutateWorkspaceState"] = async (
			_workspacePath,
			mutate,
		) => {
			const mutation = mutate(persistedState);
			const saved = mutation.save !== false;
			if (saved) {
				persistedState = {
					...persistedState,
					board: mutation.board,
					revision: persistedState.revision + 1,
				};
			}
			return { value: mutation.value, state: persistedState, saved };
		};
		const broadcastRuntimeWorkspaceStateUpdated = vi.fn();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(async () => persistedState),
			mutateWorkspaceState,
			broadcastRuntimeWorkspaceStateUpdated,
		});

		await expect(
			api.enqueueTaskExecution(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ taskId: "task-1", resumeFromTrash: true },
			),
		).resolves.toEqual({
			ok: true,
			state: "queued",
			task: { id: "task-1", generation: 4 },
			attempt: {
				attemptId: "absurd-task-1",
				generation: 4,
				queuedAt: expect.any(Number),
			},
		});
		expect(absurdTaskStartMocks.enqueueAbsurdTaskStart).toHaveBeenCalledWith({
			taskExecutionReference: expect.stringMatching(/^task-1~g4~q[1-9]\d*~resume$/u),
			projectPath: "/tmp/repo",
			agentId: "claude",
		});
		expect(persistedState.board.columns[3]?.cards[0]?.execution).toEqual({
			attemptId: "absurd-task-1",
			generation: 4,
			queuedAt: expect.any(Number),
		});
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith("workspace-1", "/tmp/repo");
	});

	it("persists an admitted attempt after the task reaches review", async () => {
		let persistedState = createWorkspaceStateWithTask({ columnId: "backlog", generation: 2 });
		absurdTaskStartMocks.enqueueAbsurdTaskStart.mockImplementationOnce(async () => {
			const moved = moveTaskToColumn(persistedState.board, "task-1", "review");
			persistedState = { ...persistedState, board: moved.board, revision: persistedState.revision + 1 };
			return { attemptId: "attempt-1", raw: { task_id: "attempt-1" } };
		});
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(async () => persistedState),
			mutateWorkspaceState: async (_workspacePath, mutate) => {
				const mutation = mutate(persistedState);
				const saved = mutation.save !== false;
				if (saved) {
					persistedState = {
						...persistedState,
						board: mutation.board,
						revision: persistedState.revision + 1,
					};
				}
				return { value: mutation.value, state: persistedState, saved };
			},
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		});

		const response = await api.enqueueTaskExecution(
			{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
			{ taskId: "task-1" },
		);

		expect(response.ok).toBe(true);
		expect(persistedState.board.columns.find((column) => column.id === "review")?.cards[0]?.execution).toEqual({
			attemptId: "attempt-1",
			generation: 2,
			queuedAt: expect.any(Number),
		});
	});

	it("orders concurrent attempt receipts even when the clock does not advance", async () => {
		let persistedState = createWorkspaceStateWithTask({ columnId: "backlog" });
		const receiptResolvers: Array<(receipt: { attemptId: string; raw: unknown }) => void> = [];
		absurdTaskStartMocks.enqueueAbsurdTaskStart.mockImplementation(
			async () => await new Promise((resolve) => receiptResolvers.push(resolve)),
		);
		const broadcastRuntimeWorkspaceStateUpdated = vi.fn();
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({}) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(async () => persistedState),
			mutateWorkspaceState: async (_workspacePath, mutate) => {
				const mutation = mutate(persistedState);
				const saved = mutation.save !== false;
				if (saved) {
					persistedState = {
						...persistedState,
						board: mutation.board,
						revision: persistedState.revision + 1,
					};
				}
				return { value: mutation.value, state: persistedState, saved };
			},
			broadcastRuntimeWorkspaceStateUpdated,
		});
		const now = vi.spyOn(Date, "now").mockReturnValue(100);
		try {
			const first = api.enqueueTaskExecution(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ taskId: "task-1" },
			);
			await vi.waitFor(() => expect(receiptResolvers).toHaveLength(1));
			const second = api.enqueueTaskExecution(
				{ workspaceId: "workspace-1", workspacePath: "/tmp/repo" },
				{ taskId: "task-1" },
			);
			await vi.waitFor(() => expect(receiptResolvers).toHaveLength(2));

			receiptResolvers[1]?.({ attemptId: "attempt-newer", raw: {} });
			await second;
			receiptResolvers[0]?.({ attemptId: "attempt-older", raw: {} });
			await first;
		} finally {
			now.mockRestore();
		}

		expect(persistedState.board.columns[0]?.cards[0]?.execution).toEqual({
			attemptId: "attempt-newer",
			generation: 1,
			queuedAt: 101,
		});
		expect(absurdTaskStartMocks.enqueueAbsurdTaskStart).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ taskExecutionReference: "task-1~g1~q100" }),
		);
		expect(absurdTaskStartMocks.enqueueAbsurdTaskStart).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ taskExecutionReference: "task-1~g1~q101" }),
		);
		expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledTimes(1);
	});

	it("returns the scoped terminal manager command journal without persisting it", async () => {
		const entries = [
			{
				id: "1000-1",
				taskId: "task-1",
				agentId: "codex" as const,
				cwd: "/tmp/task-1",
				command: ["zmx", "attach", "session", "codex", "<task-prompt>"],
				status: "started" as const,
				pid: 1234,
				startedAt: 1_000,
				error: null,
			},
		];
		const listWorkerCommandLog = vi.fn(() => entries);
		const api = createTestRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => "workspace-1"),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => ({ listWorkerCommandLog }) as never),
			resolveInteractiveShellCommand: vi.fn(),
			runCommand: vi.fn(),
		});

		const response = await api.getWorkerCommandLog({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		});

		expect(response).toEqual({
			generatedAt: expect.any(Number),
			entries,
		});
		expect(listWorkerCommandLog).toHaveBeenCalledOnce();
	});
});
