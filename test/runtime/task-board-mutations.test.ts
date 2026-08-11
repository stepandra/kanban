import { describe, expect, it } from "vitest";

import { type RuntimeBoardData, runtimeBoardCardSchema } from "../../src/core/api-contract";
import {
	addTaskDependency,
	addTaskToColumn,
	canAddTaskDependency,
	deleteTasksFromBoard,
	discardTask,
	moveTaskToColumn,
	recordTaskExecutionAttempt,
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
	it("rejects starting a dependent while a prerequisite is pending", () => {
		const createDependent = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Dependent task", baseRef: "main" },
			() => "aaaaa111",
		);
		const createPrerequisite = addTaskToColumn(
			createDependent.board,
			"backlog",
			{ prompt: "Prerequisite", baseRef: "main" },
			() => "bbbbb111",
		);
		const linked = addTaskDependency(createPrerequisite.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}

		const started = moveTaskToColumn(linked.board, "aaaaa", "in_progress");

		expect(started.moved).toBe(false);
		expect(started.board).toBe(linked.board);
	});

	it("keeps a dependent blocked when its prerequisite is discarded from the in_progress column", () => {
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
		const admitted = recordTaskExecutionAttempt(linked.board, "bbbbb", {
			attemptId: "attempt-1",
			generation: 1,
			queuedAt: 10,
		});

		const trashed = discardTask(admitted.board, "bbbbb");
		expect(trashed.board.dependencies).toHaveLength(1);
		expect(trashed.task?.execution).toBeUndefined();
	});

	it("keeps a dependent blocked when its prerequisite is discarded from the backlog column", () => {
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

		const trashed = discardTask(linked.board, "bbbbb");
		expect(trashed.board.dependencies).toHaveLength(1);
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
		const firstTrash = discardTask(linked.board, "bbbbb");
		expect(firstTrash.board.dependencies).toHaveLength(1);

		const secondTrash = discardTask(firstTrash.board, "bbbbb");
		expect(secondTrash.moved).toBe(false);
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

	it("rejects a dependency added after the dependent execution is admitted", () => {
		const dependent = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Dependent", baseRef: "main" },
			() => "aaaaa111",
		);
		const prerequisite = addTaskToColumn(
			dependent.board,
			"backlog",
			{ prompt: "Prerequisite", baseRef: "main" },
			() => "bbbbb111",
		);
		const admitted = recordTaskExecutionAttempt(prerequisite.board, "aaaaa", {
			attemptId: "attempt-1",
			generation: 1,
			queuedAt: 1,
		});

		const linked = addTaskDependency(admitted.board, "aaaaa", "bbbbb");

		expect(linked).toMatchObject({ added: false, reason: "task_admitted" });
		expect(linked.board).toBe(admitted.board);
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
	it("refuses to delete a task while a surviving task still references it", () => {
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
		const trashed = discardTask(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(false);
		expect(deleted.deletedTaskIds).toEqual([]);
		expect(deleted.blockedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board).toBe(trashed.board);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.blockedTaskIds).toEqual([]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});

	it("deletes a complete linked task set without changing dependency state for surviving tasks", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const board = {
			...createB.board,
			dependencies: [{ id: "dependency-1", fromTaskId: "aaaaa", toTaskId: "bbbbb", createdAt: 1 }],
		};

		const deleted = deleteTasksFromBoard(board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.dependencies).toEqual([]);
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

describe("task execution generation", () => {
	it("starts new tasks at generation one", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", agentId: "codex" },
			() => "aaaaa111",
		);

		expect(created.task.generation).toBe(1);
	});

	it("increments only when the execution contract changes", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", agentId: "codex", priority: 5 },
			() => "aaaaa111",
		);
		const metadataOnly = updateTask(created.board, created.task.id, {
			title: "Renamed task",
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
			priority: 10,
		});
		const changedPrompt = updateTask(metadataOnly.board, created.task.id, {
			title: "Renamed task",
			prompt: "Changed task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(metadataOnly.task?.generation).toBe(1);
		expect(changedPrompt.task?.generation).toBe(2);
	});

	it("records attempt receipts only for the current generation", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", agentId: "codex" },
			() => "aaaaa111",
		);
		const recorded = recordTaskExecutionAttempt(
			created.board,
			created.task.id,
			{ attemptId: "attempt-1", generation: 1, queuedAt: 10 },
			11,
		);
		const stale = recordTaskExecutionAttempt(
			recorded.board,
			created.task.id,
			{ attemptId: "attempt-stale", generation: 2, queuedAt: 12 },
			13,
		);

		expect(recorded).toMatchObject({ recorded: true, updated: true });
		expect(recorded.task?.execution).toEqual({ attemptId: "attempt-1", generation: 1, queuedAt: 10 });
		expect(recorded.task?.updatedAt).toBe(11);
		expect(stale).toMatchObject({ recorded: false, updated: false, reason: "generation_mismatch" });
		expect(stale.board).toBe(recorded.board);
	});

	it("does not let a delayed enqueue response overwrite a newer attempt receipt", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", agentId: "codex" },
			() => "aaaaa111",
		);
		const newer = recordTaskExecutionAttempt(created.board, created.task.id, {
			attemptId: "attempt-newer",
			generation: 1,
			queuedAt: 20,
		});
		const delayed = recordTaskExecutionAttempt(newer.board, created.task.id, {
			attemptId: "attempt-older",
			generation: 1,
			queuedAt: 10,
		});

		expect(delayed).toMatchObject({ recorded: true, updated: false });
		expect(delayed.board).toBe(newer.board);
		expect(delayed.task?.execution).toEqual({ attemptId: "attempt-newer", generation: 1, queuedAt: 20 });
	});

	it("clears the previous attempt receipt when the execution contract changes", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", agentId: "codex" },
			() => "aaaaa111",
		);
		const recorded = recordTaskExecutionAttempt(created.board, created.task.id, {
			attemptId: "attempt-1",
			generation: 1,
			queuedAt: 10,
		});
		const metadataOnly = updateTask(recorded.board, created.task.id, {
			title: "Renamed task",
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
		});
		const changedPrompt = updateTask(metadataOnly.board, created.task.id, {
			title: "Renamed task",
			prompt: "Changed task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(metadataOnly.task?.execution).toEqual({ attemptId: "attempt-1", generation: 1, queuedAt: 10 });
		expect(changedPrompt.task?.generation).toBe(2);
		expect(changedPrompt.task?.execution).toBeUndefined();
	});

	it("preserves Amp Architect provenance without treating it as execution state", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "codex",
				origin: {
					kind: "amp_architect",
					threadId: "T-019fb3aa-000b-752a-a88e-337592dae657",
				},
			},
			() => "aaaaa111",
		);
		const updated = updateTask(created.board, created.task.id, {
			title: "Renamed task",
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(created.task.origin).toEqual({
			kind: "amp_architect",
			threadId: "T-019fb3aa-000b-752a-a88e-337592dae657",
		});
		expect(updated.task?.origin).toEqual(created.task.origin);
		expect(updated.task?.generation).toBe(1);
	});

	it("loads legacy tasks without provenance", () => {
		const legacyCard = runtimeBoardCardSchema.parse({
			id: "legacy",
			title: "Legacy task",
			prompt: "Legacy task",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});

		expect(legacyCard.origin).toBeUndefined();
	});

	it("migrates legacy Cline cards to a blocked marker and advances on reassignment", () => {
		const legacyCard = runtimeBoardCardSchema.parse({
			id: "legacy",
			title: "Legacy task",
			prompt: "Legacy task",
			startInPlanMode: false,
			agentId: "cline",
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});
		const board: RuntimeBoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [legacyCard] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};
		const reassigned = updateTask(board, "legacy", {
			title: "Legacy task",
			prompt: "Legacy task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(legacyCard.agentId).toBeUndefined();
		expect(legacyCard.removedAgentId).toBe("cline");
		expect(reassigned.task?.agentId).toBe("codex");
		expect(reassigned.task?.removedAgentId).toBeUndefined();
		expect(reassigned.task?.generation).toBe(2);
	});
});
