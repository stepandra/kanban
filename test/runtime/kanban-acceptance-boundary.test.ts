import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskAcceptanceEvidence } from "../../src/core/api-contract";
import { acceptTaskWithEvidence, moveTaskToColumn } from "../../src/core/task-board-mutations";

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

	it("moves Review to Done only when acceptance evidence is attached atomically", () => {
		const accepted = acceptTaskWithEvidence(createReviewBoard(), "task-1", acceptanceEvidence);
		expect(accepted.moved).toBe(true);
		expect(accepted.acceptanceEvidence).toEqual(acceptanceEvidence);
		expect(accepted.board.columns.find((column) => column.id === "review")?.cards).toEqual([]);
		expect(accepted.board.columns.find((column) => column.id === "trash")?.cards[0]?.acceptanceEvidence).toEqual(
			acceptanceEvidence,
		);
	});
});
