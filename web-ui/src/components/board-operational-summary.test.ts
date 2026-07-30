import { describe, expect, it } from "vitest";

import { getBoardOperationalCounts } from "@/components/board-operational-summary";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardData } from "@/types";

function createCard(id: string, overrides?: Partial<BoardCard>): BoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createSession(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

describe("getBoardOperationalCounts", () => {
	it("summarizes full board health without counting done tasks as open", () => {
		const data: BoardData = {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [createCard("ready"), createCard("removed", { removedAgentId: "cline" })],
				},
				{ id: "in_progress", title: "In Progress", cards: [createCard("running"), createCard("failed")] },
				{ id: "review", title: "Review", cards: [createCard("review")] },
				{ id: "trash", title: "Done", cards: [createCard("done")] },
			],
			dependencies: [],
		};

		expect(
			getBoardOperationalCounts(data, {
				running: createSession("running", "running"),
				failed: createSession("failed", "failed"),
				done: createSession("done", "failed"),
			}),
		).toEqual({
			open: 5,
			attached: 1,
			review: 1,
			attention: 2,
		});
	});
});
