import { describe, expect, it } from "vitest";

import {
	type RuntimeBoardData,
	type RuntimeTaskAcceptanceEvidence,
	runtimeBoardCardSchema,
} from "../../src/core/api-contract";
import { discardTask, moveTaskToColumn } from "../../src/core/task-board-mutations";

function createReviewBoard(): RuntimeBoardData {
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
						title: "Verify publication",
						prompt: "Verify publication",
						startInPlanMode: false,
						baseRef: "main",
						execution: { attemptId: "attempt-1", generation: 1, queuedAt: 10 },
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

const acceptanceEvidence: RuntimeTaskAcceptanceEvidence = {
	kind: "verified_remote_revision",
	taskId: "task-1",
	generation: 1,
	executionAttemptId: "attempt-1",
	acceptedRevision: {
		sha: "0123456789abcdef0123456789abcdef01234567",
		remoteRef: "refs/heads/kanban/task-1-review",
	},
	verifiedAt: 2,
};

describe("Kanban acceptance boundary", () => {
	it("rejects an ordinary Review to Done move", () => {
		const moved = moveTaskToColumn(createReviewBoard(), "task-1", "trash", 2);
		expect(moved.moved).toBe(false);
		expect(moved.fromColumnId).toBe("review");
		expect(moved.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(1);
	});

	it("rejects an ordinary Review to Done move even when stale acceptance evidence exists", () => {
		const board = createReviewBoard();
		const reviewTask = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected the review task to exist.");
		}
		reviewTask.acceptanceEvidence = acceptanceEvidence;

		const moved = moveTaskToColumn(board, "task-1", "trash", 3);

		expect(moved.moved).toBe(false);
		expect(moved.board.columns.find((column) => column.id === "review")?.cards[0]?.acceptanceEvidence).toEqual(
			acceptanceEvidence,
		);
	});

	it("migrates legacy acceptance evidence to the task generation when loading a card", () => {
		const parsed = runtimeBoardCardSchema.parse({
			id: "legacy-accepted",
			title: "Legacy accepted task",
			prompt: "Legacy accepted task",
			startInPlanMode: false,
			generation: 3,
			acceptanceEvidence: {
				kind: "verified_remote_revision",
				acceptedRevision: acceptanceEvidence.acceptedRevision,
				verifiedAt: 2,
			},
			baseRef: "main",
			createdAt: 1,
			updatedAt: 2,
		});

		expect(parsed.acceptanceEvidence).toMatchObject({ taskId: "legacy-accepted", generation: 3 });
	});

	it("clears historical acceptance evidence when a Done task is reopened", () => {
		const board = createReviewBoard();
		const task = board.columns.find((column) => column.id === "review")?.cards[0];
		if (!task) {
			throw new Error("Expected review task.");
		}
		task.acceptanceEvidence = acceptanceEvidence;
		const accepted = discardTask(board, "task-1");

		const reopened = moveTaskToColumn(accepted.board, "task-1", "review", 3);

		expect(reopened.moved).toBe(true);
		expect(
			reopened.board.columns.find((column) => column.id === "review")?.cards[0]?.acceptanceEvidence,
		).toBeUndefined();
	});
});
