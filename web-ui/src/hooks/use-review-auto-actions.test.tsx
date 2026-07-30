import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { type AutoReviewTaskState, autoReviewTaskReducer, useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import { resetWorkspaceMetadataStore, setTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardColumnId, BoardData, ReviewTaskWorkspaceSnapshot } from "@/types";

function createBoard(autoReviewEnabled: boolean): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Test task",
						prompt: "Test task",
						startInPlanMode: false,
						autoReviewEnabled,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

const workspaceSnapshots: Record<string, ReviewTaskWorkspaceSnapshot> = {
	"task-1": {
		taskId: "task-1",
		path: "/tmp/task-1",
		exists: true,
		branch: "task-1",
		isDetached: false,
		headCommit: "abc123",
		changeId: null,
		changedFiles: 3,
		additions: 10,
		deletions: 2,
	},
};

function HookHarness({
	board,
	runAutoReviewGitAction,
	taskGitActionLoadingByTaskId = {},
}: {
	board: BoardData;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	requestMoveTaskToTrash: (taskId: string, fromColumnId: BoardColumnId) => Promise<void>;
	taskGitActionLoadingByTaskId?: Record<string, { commitSource: string | null; prSource: string | null }>;
}): null {
	setTaskWorkspaceSnapshot(workspaceSnapshots["task-1"] ?? null);
	useReviewAutoActions({
		board,
		taskGitActionLoadingByTaskId,
		runAutoReviewGitAction,
	});
	return null;
}

describe("useReviewAutoActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		resetWorkspaceMetadataStore();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	it("cancels a scheduled auto review action when autoReviewEnabled is turned off", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(false)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("does not retry a failed auto review action until the task state changes", async () => {
		const board = createBoard(true);
		let resolveAutoReviewAction: ((triggered: boolean) => void) | null = null;
		const runAutoReviewGitAction = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveAutoReviewAction = resolve;
				}),
		);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
		});

		expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
					taskGitActionLoadingByTaskId={{ "task-1": { commitSource: "card", prSource: null } }}
				/>,
			);
		});

		await act(async () => {
			resolveAutoReviewAction?.(false);
			await Promise.resolve();
			root.render(
				<HookHarness
					board={board}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(2_000);
			await Promise.resolve();
		});

		expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(false)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});
		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
		});

		expect(runAutoReviewGitAction).toHaveBeenCalledTimes(2);
	});

	it("prepares review artifacts but never accepts the task from UI automation", async () => {
		const originalSnapshot = workspaceSnapshots["task-1"] as ReviewTaskWorkspaceSnapshot;
		const board = createBoard(true);
		let resolveAutoReviewAction: ((triggered: boolean) => void) | null = null;
		const runAutoReviewGitAction = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveAutoReviewAction = resolve;
				}),
		);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		try {
			// idle -> scheduled-git-action: changes are present, but the debounce has not elapsed yet.
			await act(async () => {
				root.render(
					<HookHarness
						board={board}
						runAutoReviewGitAction={runAutoReviewGitAction}
						requestMoveTaskToTrash={requestMoveTaskToTrash}
					/>,
				);
			});
			expect(runAutoReviewGitAction).not.toHaveBeenCalled();

			// scheduled-git-action -> awaiting-clean: the debounce fires the git action.
			await act(async () => {
				vi.advanceTimersByTime(500);
				await Promise.resolve();
			});
			expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);
			expect(requestMoveTaskToTrash).not.toHaveBeenCalled();

			// awaiting-clean: the git action triggered and the workspace snapshot becomes clean.
			await act(async () => {
				resolveAutoReviewAction?.(true);
				await Promise.resolve();
			});
			workspaceSnapshots["task-1"] = { ...originalSnapshot, changedFiles: 0 };
			await act(async () => {
				root.render(
					<HookHarness
						board={board}
						runAutoReviewGitAction={runAutoReviewGitAction}
						requestMoveTaskToTrash={requestMoveTaskToTrash}
					/>,
				);
			});
			expect(requestMoveTaskToTrash).not.toHaveBeenCalled();

			// A clean artifact ends automation without moving Review to Done.
			await act(async () => {
				vi.advanceTimersByTime(500);
				await Promise.resolve();
			});
			expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
			await act(async () => {
				vi.advanceTimersByTime(2_000);
				await Promise.resolve();
			});
			expect(runAutoReviewGitAction).toHaveBeenCalledTimes(1);
			expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
		} finally {
			workspaceSnapshots["task-1"] = originalSnapshot;
		}
	});
});

describe("autoReviewTaskReducer", () => {
	it("walks idle through artifact preparation and back to idle", () => {
		let state: AutoReviewTaskState = { kind: "idle" };
		state = autoReviewTaskReducer(state, { type: "schedule", action: "commit", timerId: 1 });
		expect(state).toEqual({ kind: "scheduled-git-action", action: "commit", timerId: 1 });
		state = autoReviewTaskReducer(state, { type: "git-action-fired" });
		expect(state).toEqual({ kind: "awaiting-clean", action: "commit" });
		state = autoReviewTaskReducer(state, { type: "git-action-triggered" });
		expect(state).toEqual({ kind: "awaiting-clean", action: "commit" });
		state = autoReviewTaskReducer(state, { type: "workspace-clean" });
		expect(state).toEqual({ kind: "idle" });
	});

	it("records a failed attempt and re-arms on the next schedule", () => {
		let state: AutoReviewTaskState = { kind: "idle" };
		state = autoReviewTaskReducer(state, { type: "schedule", action: "commit", timerId: 1 });
		state = autoReviewTaskReducer(state, { type: "git-action-fired" });
		state = autoReviewTaskReducer(state, { type: "git-action-failed", action: "commit", attemptKey: "key-1" });
		expect(state).toEqual({ kind: "failed", attemptKey: "key-1" });
		state = autoReviewTaskReducer(state, { type: "schedule", action: "commit", timerId: 2 });
		expect(state).toEqual({ kind: "scheduled-git-action", action: "commit", timerId: 2 });
		state = autoReviewTaskReducer(state, { type: "reset" });
		expect(state).toEqual({ kind: "idle" });
	});
});
