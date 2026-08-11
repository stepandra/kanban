import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLinkedBacklogTaskActions } from "@/hooks/use-linked-backlog-task-actions";
import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import type { BoardCard, BoardData, BoardDependency } from "@/types";

const trackTaskDependencyCreatedMock = vi.hoisted(() => vi.fn());

vi.mock("@/telemetry/events", () => ({
	trackTaskDependencyCreated: trackTaskDependencyCreatedMock,
}));

function createTask(taskId: string, prompt: string, createdAt: number): BoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function createBoard(dependencies: BoardDependency[] = []): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [createTask("task-1", "Backlog task", 1), createTask("task-3", "Second backlog task", 3)],
			},
			{
				id: "in_progress",
				title: "In Progress",
				cards: [createTask("task-2", "In-progress task", 2)],
			},
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies,
	};
}

interface HookSnapshot {
	board: BoardData;
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: "backlog" | "in_progress" | "review" | "trash",
	) => Promise<void>;
}

function HookHarness({
	boardFactory,
	onSnapshot,
	stopTaskSession,
}: {
	boardFactory?: () => BoardData;
	onSnapshot: (snapshot: HookSnapshot) => void;
	stopTaskSession?: (taskId: string, executionAttemptId?: string | null) => Promise<void>;
}): null {
	const [board, setBoard] = useState<BoardData>(() => (boardFactory ? boardFactory() : createBoard()));
	const actions = useLinkedBacklogTaskActions({
		board,
		setBoard,
		setSelectedTaskId: () => {},
		stopTaskSession: stopTaskSession ?? (async () => {}),
	});

	useEffect(() => {
		onSnapshot({
			board,
			handleCreateDependency: actions.handleCreateDependency,
			confirmMoveTaskToTrash: actions.confirmMoveTaskToTrash,
			requestMoveTaskToTrash: actions.requestMoveTaskToTrash,
		});
	}, [
		actions.confirmMoveTaskToTrash,
		actions.handleCreateDependency,
		actions.requestMoveTaskToTrash,
		board,
		onSnapshot,
	]);

	return null;
}

describe("useLinkedBacklogTaskActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		trackTaskDependencyCreatedMock.mockReset();
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
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("tracks dependency creation after a valid link is added", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;

		await act(async () => {
			initialSnapshot.handleCreateDependency("task-1", "task-2");
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an updated hook snapshot.");
		}
		const snapshot = latestSnapshot as HookSnapshot;

		expect(trackTaskDependencyCreatedMock).toHaveBeenCalledTimes(1);
		expect(snapshot.board.dependencies).toHaveLength(1);
		expect(snapshot.board.dependencies[0]).toMatchObject({
			fromTaskId: "task-1",
			toTaskId: "task-2",
		});
	});

	it("keeps linked backlog tasks blocked when a prerequisite is discarded", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const boardFactory = () =>
			createBoard([
				{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
				{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
			]);

		await act(async () => {
			root.render(
				<HookHarness
					boardFactory={boardFactory}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const activeTask = initialSnapshot.board.columns.find((column) => column.id === "in_progress")?.cards[0];
		if (!activeTask) {
			throw new Error("Expected an in-progress task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(activeTask, initialSnapshot.board);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an updated hook snapshot.");
		}
		const discardedSnapshot = latestSnapshot as HookSnapshot;
		expect(discardedSnapshot.board.dependencies).toHaveLength(2);
		expect(discardedSnapshot.board.columns.find((column) => column.id === "backlog")?.cards).toHaveLength(2);
	});

	it("stops task sessions but retains the task workspace when a task is discarded", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const stopTaskSession = vi.fn(async (_taskId: string) => {});
		const boardFactory = () => {
			const board = createBoard();
			const activeTask = board.columns.find((column) => column.id === "in_progress")?.cards[0];
			if (activeTask) {
				activeTask.execution = { attemptId: "attempt-1", generation: 1, queuedAt: 10 };
			}
			return board;
		};

		await act(async () => {
			root.render(
				<HookHarness
					boardFactory={boardFactory}
					stopTaskSession={stopTaskSession}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const activeTask = initialSnapshot.board.columns.find((column) => column.id === "in_progress")?.cards[0];
		if (!activeTask) {
			throw new Error("Expected an in-progress task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(activeTask, initialSnapshot.board);
		});

		expect(stopTaskSession).toHaveBeenCalledTimes(2);
		expect(stopTaskSession).toHaveBeenNthCalledWith(1, activeTask.id, "attempt-1");
		expect(stopTaskSession).toHaveBeenNthCalledWith(2, getDetailTerminalTaskId(activeTask.id));
	});

	it("trashes tasks directly through the request handler", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "in_progress");
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an updated hook snapshot.");
		}
		const nextSnapshot = latestSnapshot as HookSnapshot;
		expect(nextSnapshot.board.columns.find((column) => column.id === "in_progress")?.cards).toHaveLength(0);
		expect(nextSnapshot.board.columns.find((column) => column.id === "trash")?.cards[0]?.id).toBe("task-2");
	});
});
