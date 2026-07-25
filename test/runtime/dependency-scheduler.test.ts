import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { allocateReadyTaskIds, FIXER_DISPATCH_CAPACITY, getReadyTaskQueue } from "../../src/core/dependency-scheduler";
import { addTaskDependency, addTaskToColumn, moveTaskToColumn } from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createTask(
	board: RuntimeBoardData,
	prompt: string,
	uuid: string,
	options: { priority?: number; now?: number } = {},
) {
	return addTaskToColumn(board, "backlog", { prompt, baseRef: "main", ...options }, () => uuid, options.now ?? 1000);
}

describe("getReadyTaskQueue", () => {
	it("excludes backlog tasks with pending prerequisites and tasks outside the backlog", () => {
		const createReady = createTask(createBoard(), "Ready task", "aaaaa111");
		const createBlocked = createTask(createReady.board, "Blocked task", "bbbbb111");
		const createPrerequisite = createTask(createBlocked.board, "Prerequisite", "ccccc111");
		const linked = addTaskDependency(createPrerequisite.board, "bbbbb", "ccccc");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const started = moveTaskToColumn(linked.board, "ccccc", "in_progress");

		const queue = getReadyTaskQueue(started.board);
		expect(queue.map((card) => card.id)).toEqual(["aaaaa"]);
	});

	it("orders by priority descending", () => {
		const createLow = createTask(createBoard(), "Low", "aaaaa111", { priority: 1, now: 1000 });
		const createHigh = createTask(createLow.board, "High", "bbbbb111", { priority: 10, now: 2000 });
		const createDefault = createTask(createHigh.board, "Default", "ccccc111", { now: 3000 });

		const queue = getReadyTaskQueue(createDefault.board);
		expect(queue.map((card) => card.id)).toEqual(["bbbbb", "aaaaa", "ccccc"]);
	});

	it("breaks priority ties by dependant-chain depth so unblockers schedule first", () => {
		const createUnblocker = createTask(createBoard(), "Unblocker", "aaaaa111", { now: 2000 });
		const createDependant = createTask(createUnblocker.board, "Dependant", "bbbbb111", { now: 3000 });
		const createIsolated = createTask(createDependant.board, "Isolated", "ccccc111", { now: 1000 });
		const linked = addTaskDependency(createIsolated.board, "bbbbb", "aaaaa");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}

		const queue = getReadyTaskQueue(linked.board);
		expect(queue.map((card) => card.id)).toEqual(["aaaaa", "ccccc"]);
	});

	it("breaks remaining ties by creation time, oldest first", () => {
		const createNewer = createTask(createBoard(), "Newer", "aaaaa111", { now: 2000 });
		const createOlder = createTask(createNewer.board, "Older", "bbbbb111", { now: 1000 });

		const queue = getReadyTaskQueue(createOlder.board);
		expect(queue.map((card) => card.id)).toEqual(["bbbbb", "aaaaa"]);
	});

	it("returns an empty queue when every backlog task is blocked", () => {
		const createA = createTask(createBoard(), "Task A", "aaaaa111");
		const createB = createTask(createA.board, "Task B", "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		// Moving the prerequisite out of the backlog keeps the edge, so Task A stays blocked
		// and Task B is no longer in the backlog column.
		const started = moveTaskToColumn(linked.board, "bbbbb", "in_progress");

		expect(getReadyTaskQueue(started.board)).toEqual([]);
	});
});

describe("allocateReadyTaskIds", () => {
	it("allocates at most the requested capacity from the front of the ready queue", () => {
		const createFirst = createTask(createBoard(), "First", "aaaaa111", { priority: 30, now: 1000 });
		const createSecond = createTask(createFirst.board, "Second", "bbbbb111", { priority: 20, now: 2000 });
		const createThird = createTask(createSecond.board, "Third", "ccccc111", { priority: 10, now: 3000 });

		expect(allocateReadyTaskIds(createThird.board, 2)).toEqual(["aaaaa", "bbbbb"]);
		expect(allocateReadyTaskIds(createThird.board, 1)).toEqual(["aaaaa"]);
		expect(allocateReadyTaskIds(createThird.board, 10)).toEqual(["aaaaa", "bbbbb", "ccccc"]);
	});

	it("defaults to the Fixer dispatch capacity", () => {
		expect(FIXER_DISPATCH_CAPACITY).toBe(2);
		const createFirst = createTask(createBoard(), "First", "aaaaa111", { priority: 30, now: 1000 });
		const createSecond = createTask(createFirst.board, "Second", "bbbbb111", { priority: 20, now: 2000 });
		const createThird = createTask(createSecond.board, "Third", "ccccc111", { priority: 10, now: 3000 });

		expect(allocateReadyTaskIds(createThird.board)).toEqual(["aaaaa", "bbbbb"]);
	});

	it("returns nothing for non-positive capacity or an empty board", () => {
		const createTaskOnly = createTask(createBoard(), "Task", "aaaaa111");
		expect(allocateReadyTaskIds(createTaskOnly.board, 0)).toEqual([]);
		expect(allocateReadyTaskIds(createBoard(), 2)).toEqual([]);
	});
});
