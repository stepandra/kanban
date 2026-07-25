import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskTurnCheckpoint } from "../../src/core/api-contract";
import { captureBestEffortTurnCheckpoint } from "../../src/workspace/turn-checkpoints";

function createCheckpoint(turn: number): RuntimeTaskTurnCheckpoint {
	return {
		turn,
		ref: `refs/kanban/checkpoints/task-1/turn/${turn}`,
		commit: `commit-${turn}`,
		createdAt: turn,
	};
}

describe("captureBestEffortTurnCheckpoint", () => {
	it("captures turn 1 when no previous checkpoint exists", async () => {
		const checkpoint = createCheckpoint(1);
		const capture = vi.fn(async () => checkpoint);

		const result = await captureBestEffortTurnCheckpoint({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			latestTurnCheckpoint: null,
			capture,
		});

		expect(result).toBe(checkpoint);
		expect(capture).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			turn: 1,
		});
	});

	it("advances the turn from the latest checkpoint", async () => {
		const checkpoint = createCheckpoint(3);
		const capture = vi.fn(async () => checkpoint);

		const result = await captureBestEffortTurnCheckpoint({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			latestTurnCheckpoint: createCheckpoint(2),
			capture,
		});

		expect(result).toBe(checkpoint);
		expect(capture).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			turn: 3,
		});
	});

	it("returns null when capture fails", async () => {
		const capture = vi.fn(async () => {
			throw new Error("Git turn checkpoints are unavailable in jj workspaces.");
		});

		const result = await captureBestEffortTurnCheckpoint({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			latestTurnCheckpoint: null,
			capture,
		});

		expect(result).toBeNull();
	});
});
