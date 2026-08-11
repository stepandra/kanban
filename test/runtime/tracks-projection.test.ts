import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { runtimeBoardDataSchema, runtimeTracksProjectionSchema } from "../../src/core/api-contract";
import { buildTracksProjection } from "../../src/core/tracks-projection";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "ml-train",
						title: "Train candidate",
						prompt: "Train candidate",
						startInPlanMode: false,
						planning: { trackId: "ml", milestoneId: "ml-v1", weight: 3 },
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: "unassigned",
						title: "Triage me",
						prompt: "Triage me",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 2,
						updatedAt: 2,
					},
				],
			},
			{
				id: "in_progress",
				title: "In Progress",
				cards: [
					{
						id: "backend-api",
						title: "Expose inference API",
						prompt: "Expose inference API",
						startInPlanMode: false,
						planning: { trackId: "backend", milestoneId: "backend-v1" },
						baseRef: "main",
						createdAt: 3,
						updatedAt: 3,
					},
				],
			},
			{ id: "review", title: "Review", cards: [] },
			{
				id: "trash",
				title: "Done",
				cards: [
					{
						id: "ml-eval",
						title: "Evaluation gate",
						prompt: "Evaluation gate",
						startInPlanMode: false,
						planning: { trackId: "ml", milestoneId: "ml-v1", weight: 1 },
						acceptanceEvidence: {
							kind: "verified_remote_revision",
							taskId: "ml-eval",
							generation: 1,
							acceptedRevision: {
								sha: "0123456789abcdef0123456789abcdef01234567",
								remoteRef: "refs/heads/kanban/ml-eval-accepted",
							},
							verifiedAt: 4,
						},
						baseRef: "main",
						createdAt: 4,
						updatedAt: 4,
					},
				],
			},
		],
		dependencies: [
			{
				id: "dep-cross-track",
				fromTaskId: "ml-train",
				toTaskId: "backend-api",
				createdAt: 5,
			},
		],
		tracks: [
			{ id: "backend", name: "Backend", order: 1 },
			{ id: "ml", name: "ML / LLM", order: 0 },
		],
		milestones: [
			{ id: "backend-v1", trackId: "backend", title: "Inference API", state: "active", order: 0, scopeRevision: 2 },
			{ id: "ml-v1", trackId: "ml", title: "Candidate v1", state: "active", order: 0, scopeRevision: 4 },
		],
	};
}

describe("tracks projection", () => {
	it("derives accepted progress, pipeline, unassigned scope, and cross-track blockers", () => {
		const projection = buildTracksProjection({
			projectRef: "project-a",
			revision: 12,
			generatedAt: 100,
			board: createBoard(),
		});

		expect(runtimeTracksProjectionSchema.parse(projection)).toEqual(projection);
		expect(projection.tracks.map((track) => track.trackId)).toEqual(["ml", "backend"]);
		expect(projection.tracks[0]).toMatchObject({
			activeMilestoneId: "ml-v1",
			counts: { backlog: 1, inProgress: 0, review: 0, accepted: 1 },
			progress: { acceptedWeight: 1, totalWeight: 4, percent: 25, basis: "weighted" },
		});
		expect(projection.tracks[1]).toMatchObject({
			progress: { acceptedWeight: 0, totalWeight: 1, percent: 0, basis: "count" },
		});
		expect(projection.unassigned.tasks.map((task) => task.taskId)).toEqual(["unassigned"]);
		expect(projection.crossTrackDependencies).toEqual([
			{
				dependentTaskId: "ml-train",
				prerequisiteTaskId: "backend-api",
				dependentTrackId: "ml",
				prerequisiteTrackId: "backend",
			},
		]);
	});

	it("reports unset scope instead of a misleading zero percent", () => {
		const board = createBoard();
		board.columns = board.columns.map((column) => ({ ...column, cards: [] }));
		const projection = buildTracksProjection({
			projectRef: "project-a",
			revision: 0,
			generatedAt: 100,
			board,
		});

		expect(projection.tracks[0]?.progress).toEqual({
			acceptedWeight: 0,
			totalWeight: 0,
			percent: null,
			basis: "scope_unset",
		});
	});

	it("rejects planning references that would create a second truth outside the catalog", () => {
		const board = createBoard();
		const task = board.columns[0]?.cards[0];
		if (!task) throw new Error("Missing fixture task.");
		task.planning = { trackId: "ml", milestoneId: "backend-v1" };

		expect(() => runtimeBoardDataSchema.parse(board)).toThrow("outside its track");
	});
});
