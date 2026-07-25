import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import {
	addTaskDependency,
	addTaskToColumn,
	canAddTaskDependency,
	deleteTasksFromBoard,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../../src/core/task-board-mutations";

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

describe("dependency readiness", () => {
	it("starts a dependent task only after all of its prerequisites are done", () => {
		const createDependent = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Dependent task", baseRef: "main" },
			() => "aaaaa111",
		);
		const createFirstPrerequisite = addTaskToColumn(
			createDependent.board,
			"review",
			{ prompt: "First prerequisite", baseRef: "main" },
			() => "bbbbb111",
		);
		const createSecondPrerequisite = addTaskToColumn(
			createFirstPrerequisite.board,
			"review",
			{ prompt: "Second prerequisite", baseRef: "main" },
			() => "ccccc111",
		);
		const firstLink = addTaskDependency(createSecondPrerequisite.board, "aaaaa", "bbbbb");
		if (!firstLink.added) {
			throw new Error("Expected first dependency to be created.");
		}
		const secondLink = addTaskDependency(firstLink.board, "aaaaa", "ccccc");
		if (!secondLink.added) {
			throw new Error("Expected second dependency to be created.");
		}

		const firstDone = trashTaskAndGetReadyLinkedTaskIds(secondLink.board, "bbbbb");
		expect(firstDone.readyTaskIds).toEqual([]);
		expect(firstDone.board.dependencies).toHaveLength(1);

		const allDone = trashTaskAndGetReadyLinkedTaskIds(firstDone.board, "ccccc");
		expect(allDone.readyTaskIds).toEqual(["aaaaa"]);
		expect(allDone.board.dependencies).toEqual([]);
	});

	it("unblocks a dependent when its prerequisite is trashed from the in_progress column", () => {
		const createDependent = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Dependent task", baseRef: "main" },
			() => "aaaaa111",
		);
		const createPrerequisite = addTaskToColumn(
			createDependent.board,
			"in_progress",
			{ prompt: "Prerequisite", baseRef: "main" },
			() => "bbbbb111",
		);
		const linked = addTaskDependency(createPrerequisite.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}

		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		expect(trashed.readyTaskIds).toEqual(["aaaaa"]);
		expect(trashed.board.dependencies).toEqual([]);
	});

	it("unblocks a dependent when its prerequisite is trashed from the backlog column", () => {
		const createPrerequisite = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Prerequisite", baseRef: "main" },
			() => "bbbbb111",
		);
		const createDependent = addTaskToColumn(
			createPrerequisite.board,
			"backlog",
			{ prompt: "Dependent task", baseRef: "main" },
			() => "aaaaa111",
		);
		const linked = addTaskDependency(createDependent.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}

		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		expect(trashed.readyTaskIds).toEqual(["aaaaa"]);
		expect(trashed.board.dependencies).toEqual([]);
	});

	it("unblocks nothing when an already-trashed prerequisite is trashed again", () => {
		const createDependent = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Dependent task", baseRef: "main" },
			() => "aaaaa111",
		);
		const createPrerequisite = addTaskToColumn(
			createDependent.board,
			"review",
			{ prompt: "Prerequisite", baseRef: "main" },
			() => "bbbbb111",
		);
		const linked = addTaskDependency(createPrerequisite.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const firstTrash = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		expect(firstTrash.readyTaskIds).toEqual(["aaaaa"]);

		const secondTrash = trashTaskAndGetReadyLinkedTaskIds(firstTrash.board, "bbbbb");
		expect(secondTrash.moved).toBe(false);
		expect(secondTrash.readyTaskIds).toEqual([]);
	});
});

describe("dependency cycle detection", () => {
	function createBacklogTask(board: RuntimeBoardData, prompt: string, uuid: string) {
		return addTaskToColumn(board, "backlog", { prompt, baseRef: "main" }, () => uuid);
	}

	it("rejects a direct two-task cycle", () => {
		const createA = createBacklogTask(createBoard(), "Task A", "aaaaa111");
		const createB = createBacklogTask(createA.board, "Task B", "bbbbb111");
		const firstLink = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!firstLink.added) {
			throw new Error("Expected first dependency to be created.");
		}

		const cycle = addTaskDependency(firstLink.board, "bbbbb", "aaaaa");
		expect(cycle.added).toBe(false);
		expect(cycle.reason).toBe("cycle");
		expect(cycle.board.dependencies).toHaveLength(1);
		expect(canAddTaskDependency(firstLink.board, "bbbbb", "aaaaa")).toBe(false);
	});

	it("rejects a transitive cycle across three tasks", () => {
		const createA = createBacklogTask(createBoard(), "Task A", "aaaaa111");
		const createB = createBacklogTask(createA.board, "Task B", "bbbbb111");
		const createC = createBacklogTask(createB.board, "Task C", "ccccc111");
		const firstLink = addTaskDependency(createC.board, "aaaaa", "bbbbb");
		if (!firstLink.added) {
			throw new Error("Expected first dependency to be created.");
		}
		const secondLink = addTaskDependency(firstLink.board, "bbbbb", "ccccc");
		if (!secondLink.added) {
			throw new Error("Expected second dependency to be created.");
		}

		const cycle = addTaskDependency(secondLink.board, "ccccc", "aaaaa");
		expect(cycle.added).toBe(false);
		expect(cycle.reason).toBe("cycle");
		expect(cycle.board.dependencies).toHaveLength(2);
		expect(canAddTaskDependency(secondLink.board, "ccccc", "aaaaa")).toBe(false);
	});

	it("still allows non-cyclic links sharing prerequisites", () => {
		const createA = createBacklogTask(createBoard(), "Task A", "aaaaa111");
		const createB = createBacklogTask(createA.board, "Task B", "bbbbb111");
		const createC = createBacklogTask(createB.board, "Task C", "ccccc111");
		const firstLink = addTaskDependency(createC.board, "aaaaa", "ccccc");
		if (!firstLink.added) {
			throw new Error("Expected first dependency to be created.");
		}

		const secondLink = addTaskDependency(firstLink.board, "bbbbb", "ccccc");
		expect(secondLink.added).toBe(true);
		expect(secondLink.board.dependencies).toHaveLength(2);
	});
});

describe("task priority", () => {
	it("persists priority when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Important task", baseRef: "main", priority: 10 },
			() => "aaaaa111",
		);

		expect(created.task.priority).toBe(10);
	});

	it("updates, preserves, and clears priority", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", priority: 5 },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, "aaaaa", { prompt: "Task", baseRef: "main", priority: 20 });
		expect(updated.task?.priority).toBe(20);

		const preserved = updateTask(updated.board, "aaaaa", { prompt: "Task", baseRef: "main" });
		expect(preserved.task?.priority).toBe(20);

		const cleared = updateTask(preserved.board, "aaaaa", { prompt: "Task", baseRef: "main", priority: null });
		expect(cleared.task?.priority).toBeUndefined();
	});
});

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("per-task agent overrides", () => {
	it("persists agentId on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Smart task", baseRef: "main", agentId: "claude" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("claude");
	});

	it("leaves override fields undefined when not provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Default task", baseRef: "main" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBeUndefined();
	});

	it("updates agentId from undefined to a value", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.agentId).toBeUndefined();

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.agentId).toBe("codex");
	});

	it("preserves existing overrides when update input omits them (undefined)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "claude",
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Updated prompt",
			baseRef: "main",
			// agentId is undefined, so the existing override should persist
		});

		expect(updated.task?.agentId).toBe("claude");
	});

	it("clears overrides when update input provides null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "codex",
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: null,
		});

		expect(updated.task?.agentId).toBeUndefined();
	});

	it("preserves overrides across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Movable task",
				baseRef: "main",
				agentId: "claude",
			},
			() => "aaaaa111",
		);

		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress");

		expect(moved.moved).toBe(true);
		expect(moved.task?.agentId).toBe("claude");
	});
});
