import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeWorkspaceMetadata } from "../../src/core/api-contract";
import { runtimeBoardDataSchema } from "../../src/core/api-contract";
import { createWorkspaceMetadataMonitor } from "../../src/server/workspace-metadata-monitor";
import { detectRepositoryKind } from "../../src/state/workspace-state";
import { getGitSyncSummary, probeGitWorkspaceState } from "../../src/workspace/git-sync";
import { readJjWorkspaceState } from "../../src/workspace/jj-utils";
import { getTaskWorkspacePathInfo } from "../../src/workspace/task-worktree";

vi.mock("../../src/state/workspace-state", () => ({
	detectRepositoryKind: vi.fn(() => "git"),
}));

vi.mock("../../src/workspace/git-sync", () => ({
	probeGitWorkspaceState: vi.fn(),
	getGitSyncSummary: vi.fn(),
}));

vi.mock("../../src/workspace/jj-utils", () => ({
	readJjWorkspaceState: vi.fn(),
}));

vi.mock("../../src/workspace/task-worktree", () => ({
	getTaskWorkspacePathInfo: vi.fn(),
}));

const probeMock = vi.mocked(probeGitWorkspaceState);
const summaryMock = vi.mocked(getGitSyncSummary);
const detectRepositoryKindMock = vi.mocked(detectRepositoryKind);
const readJjWorkspaceStateMock = vi.mocked(readJjWorkspaceState);
const taskPathInfoMock = vi.mocked(getTaskWorkspacePathInfo);

let stateToken = "token-0";
let changedFiles = 0;

function makeBoard(taskIds: string[] = []): RuntimeBoardData {
	return runtimeBoardDataSchema.parse({
		columns: [
			{
				id: "in_progress",
				title: "In Progress",
				cards: taskIds.map((taskId) => ({
					id: taskId,
					prompt: `Prompt for ${taskId}`,
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 0,
					updatedAt: 0,
				})),
			},
		],
		dependencies: [],
	});
}

function createMonitor() {
	const onMetadataUpdated = vi.fn<(workspaceId: string, metadata: RuntimeWorkspaceMetadata) => void>();
	const monitor = createWorkspaceMetadataMonitor({ onMetadataUpdated });
	return { monitor, onMetadataUpdated };
}

beforeEach(() => {
	stateToken = "token-0";
	changedFiles = 0;
	detectRepositoryKindMock.mockReset();
	detectRepositoryKindMock.mockReturnValue("git");
	readJjWorkspaceStateMock.mockReset();
	probeMock.mockReset();
	probeMock.mockImplementation(async () => ({
		repoRoot: "/repo",
		headCommit: "abc123",
		currentBranch: "main",
		upstreamBranch: null,
		aheadCount: 0,
		behindCount: 0,
		changedFiles,
		untrackedPaths: [],
		stateToken,
	}));
	summaryMock.mockReset();
	summaryMock.mockImplementation(async () => ({
		currentBranch: "main",
		upstreamBranch: null,
		changedFiles,
		additions: 0,
		deletions: 0,
		aheadCount: 0,
		behindCount: 0,
	}));
	taskPathInfoMock.mockReset();
	taskPathInfoMock.mockImplementation(async ({ taskId, baseRef }) => ({
		taskId,
		path: `/nonexistent-workspace/.worktrees/${taskId}`,
		exists: false,
		baseRef,
	}));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createWorkspaceMetadataMonitor", () => {
	it("publishes jj change identity with task workspace metadata", async () => {
		detectRepositoryKindMock.mockReturnValue("jj");
		taskPathInfoMock.mockResolvedValue({
			taskId: "task-1",
			path: "/repo/.worktrees/task-1",
			exists: true,
			baseRef: "main",
		});
		readJjWorkspaceStateMock.mockResolvedValue({
			changeId: "zzxxyywwvvuuttssrrqq",
			commitId: "11223344556677889900",
			changedFiles: 3,
			additions: 24,
			deletions: 7,
			stateToken: "jj-token-1",
		});
		const { monitor } = createMonitor();

		try {
			const snapshot = await monitor.connectWorkspace({
				workspaceId: "ws-1",
				workspacePath: "/repo",
				board: makeBoard(["task-1"]),
			});

			expect(snapshot.homeGitSummary).toBeNull();
			expect(snapshot.taskWorkspaces[0]).toMatchObject({
				taskId: "task-1",
				changeId: "zzxxyywwvvuuttssrrqq",
				headCommit: "11223344556677889900",
				changedFiles: 3,
			});
		} finally {
			monitor.close();
		}
	});

	it("backs off polling instead of running a fixed 1s subprocess while idle", async () => {
		vi.useFakeTimers();
		const { monitor, onMetadataUpdated } = createMonitor();
		try {
			await monitor.connectWorkspace({
				workspaceId: "ws-1",
				workspacePath: "/nonexistent-workspace",
				board: makeBoard(),
			});
			probeMock.mockClear();
			onMetadataUpdated.mockClear();

			await vi.advanceTimersByTimeAsync(1_000);
			expect(probeMock).toHaveBeenCalledTimes(1);

			// Idle refresh -> next poll after 2s, so no subprocess at t=2s.
			await vi.advanceTimersByTimeAsync(1_000);
			expect(probeMock).toHaveBeenCalledTimes(1);

			// t=3s: second idle poll -> next after 4s.
			await vi.advanceTimersByTimeAsync(1_000);
			expect(probeMock).toHaveBeenCalledTimes(2);

			// t=7s: third idle poll -> next after 8s.
			await vi.advanceTimersByTimeAsync(4_000);
			expect(probeMock).toHaveBeenCalledTimes(3);

			// t=15s: fourth idle poll -> delay capped at 10s, next at t=25s.
			await vi.advanceTimersByTimeAsync(8_000);
			expect(probeMock).toHaveBeenCalledTimes(4);

			// 24 idle seconds caused 4 probes; a fixed 1s poll would have caused 24.
			expect(onMetadataUpdated).not.toHaveBeenCalled();
		} finally {
			monitor.close();
		}
	});

	it("detects changes within ~1s while the workspace stays active", async () => {
		vi.useFakeTimers();
		const { monitor, onMetadataUpdated } = createMonitor();
		try {
			await monitor.connectWorkspace({
				workspaceId: "ws-1",
				workspacePath: "/nonexistent-workspace",
				board: makeBoard(["task-1"]),
			});
			onMetadataUpdated.mockClear();

			taskPathInfoMock.mockImplementation(async ({ taskId, baseRef }) => ({
				taskId,
				path: `/nonexistent-workspace/.worktrees/${taskId}`,
				exists: true,
				baseRef,
			}));
			stateToken = "token-1";
			changedFiles = 1;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(onMetadataUpdated).toHaveBeenCalledTimes(1);

			// A detected change keeps the fast cadence: the next change is again
			// picked up one second later (well within the ~2s budget).
			stateToken = "token-2";
			changedFiles = 2;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(onMetadataUpdated).toHaveBeenCalledTimes(2);

			const lastMetadata = onMetadataUpdated.mock.calls.at(-1)?.[1];
			expect(lastMetadata?.homeGitSummary?.changedFiles).toBe(2);
			expect(lastMetadata?.taskWorkspaces[0]?.changedFiles).toBe(2);
		} finally {
			monitor.close();
		}
	});

	it("refreshes promptly when the .git watcher fires", async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), "kanban-metadata-monitor-"));
		await mkdir(join(workspacePath, ".git"));
		const { monitor, onMetadataUpdated } = createMonitor();
		try {
			await monitor.connectWorkspace({
				workspaceId: "ws-1",
				workspacePath,
				board: makeBoard(),
			});
			onMetadataUpdated.mockClear();

			stateToken = "token-watch";
			changedFiles = 3;
			await writeFile(join(workspacePath, ".git", "COMMIT_EDITMSG"), "commit\n", "utf8");

			await vi.waitFor(
				() => {
					expect(onMetadataUpdated).toHaveBeenCalledTimes(1);
				},
				{ timeout: 2_000, interval: 20 },
			);
			expect(onMetadataUpdated.mock.calls[0]?.[1].homeGitSummary?.changedFiles).toBe(3);
		} finally {
			monitor.close();
			await rm(workspacePath, { recursive: true, force: true });
		}
	});

	it("keeps polling until the last subscriber disconnects", async () => {
		vi.useFakeTimers();
		const { monitor } = createMonitor();
		try {
			const input = {
				workspaceId: "ws-1",
				workspacePath: "/nonexistent-workspace",
				board: makeBoard(),
			};
			await monitor.connectWorkspace(input);
			await monitor.connectWorkspace(input);
			probeMock.mockClear();

			await vi.advanceTimersByTimeAsync(1_000);
			expect(probeMock).toHaveBeenCalledTimes(1);

			// One subscriber left: polling continues (next poll due at t=3s).
			monitor.disconnectWorkspace("ws-1");
			await vi.advanceTimersByTimeAsync(2_000);
			expect(probeMock).toHaveBeenCalledTimes(2);

			// Last subscriber gone: polling stops entirely.
			monitor.disconnectWorkspace("ws-1");
			await vi.advanceTimersByTimeAsync(30_000);
			expect(probeMock).toHaveBeenCalledTimes(2);
		} finally {
			monitor.close();
		}
	});

	it("stops polling when the workspace is disposed", async () => {
		vi.useFakeTimers();
		const { monitor } = createMonitor();
		try {
			await monitor.connectWorkspace({
				workspaceId: "ws-1",
				workspacePath: "/nonexistent-workspace",
				board: makeBoard(),
			});
			probeMock.mockClear();

			monitor.disposeWorkspace("ws-1");
			await vi.advanceTimersByTimeAsync(30_000);
			expect(probeMock).not.toHaveBeenCalled();
		} finally {
			monitor.close();
		}
	});
});
