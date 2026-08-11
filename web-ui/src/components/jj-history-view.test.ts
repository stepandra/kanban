import { describe, expect, it } from "vitest";

import { buildJjTaskLinks } from "@/components/jj-history-view";
import type { RuntimeTaskWorkspaceMetadata } from "@/runtime/types";
import type { BoardData } from "@/types";

const board: BoardData = {
	columns: [
		{
			id: "in_progress",
			title: "In Progress",
			cards: [
				{
					id: "task-1",
					title: "Linked task",
					prompt: "Linked task",
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 1,
					updatedAt: 1,
				},
			],
		},
	],
	dependencies: [],
};

function createMetadata(overrides?: Partial<RuntimeTaskWorkspaceMetadata>): RuntimeTaskWorkspaceMetadata {
	return {
		taskId: "task-1",
		path: "/tmp/task-1",
		exists: true,
		baseRef: "main",
		branch: null,
		isDetached: false,
		headCommit: "1111",
		changeId: "zzzz",
		changedFiles: 1,
		additions: 1,
		deletions: 0,
		stateVersion: 1,
		...overrides,
	};
}

describe("buildJjTaskLinks", () => {
	it("links real task workspaces by jj change ID and uses the task title as the label", () => {
		expect(buildJjTaskLinks(board, [createMetadata()])).toEqual([
			{
				taskId: "task-1",
				title: "Linked task",
				changeId: "zzzz",
			},
		]);
	});

	it("does not invent links for pending workspaces or unknown tasks", () => {
		expect(
			buildJjTaskLinks(board, [
				createMetadata({ exists: false }),
				createMetadata({ taskId: "unknown" }),
				createMetadata({ changeId: null }),
			]),
		).toEqual([]);
	});
});
