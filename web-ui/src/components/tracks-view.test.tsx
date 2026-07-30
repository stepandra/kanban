import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TracksViewContent } from "@/components/tracks-view";
import type { RuntimeTracksProjection } from "@/runtime/types";

const projection: RuntimeTracksProjection = {
	schema: "kanban-tracks-projection/v1",
	projectRef: "project-1",
	revision: 7,
	generatedAt: 100,
	tracks: [
		{
			trackId: "backend",
			name: "Backend",
			description: "Runtime authority and APIs",
			order: 0,
			archived: false,
			activeMilestoneId: "backend-m1",
			counts: { backlog: 1, inProgress: 1, review: 0, accepted: 2 },
			progress: { acceptedWeight: 2, totalWeight: 4, percent: 50, basis: "count" },
			milestones: [
				{
					milestoneId: "backend-m1",
					title: "Durable execution",
					definitionOfDone: "All lifecycle receipts are persisted",
					state: "active",
					order: 0,
					scopeRevision: 2,
					counts: { backlog: 1, inProgress: 1, review: 0, accepted: 2 },
					progress: { acceptedWeight: 2, totalWeight: 4, percent: 50, basis: "count" },
					tasks: [
						{
							taskId: "task-1",
							title: "Persist acceptance receipts",
							status: "in_progress",
							weight: 1,
							blockedByCount: 1,
						},
					],
				},
			],
		},
	],
	unassigned: {
		counts: { backlog: 1, inProgress: 0, review: 0, accepted: 0 },
		tasks: [
			{
				taskId: "task-2",
				title: "Unassigned docs",
				status: "backlog",
				weight: 1,
				blockedByCount: 0,
			},
		],
	},
	crossTrackDependencies: [],
};

describe("TracksViewContent", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	it("shows current milestone progress and navigates to the task or linked jj change", () => {
		const onSelectTask = vi.fn();
		const onOpenTaskChange = vi.fn();
		act(() => {
			root.render(
				<TracksViewContent
					projection={projection}
					jjTaskLinks={[{ taskId: "task-1", title: "Persist acceptance receipts", changeId: "abc" }]}
					onSelectTask={onSelectTask}
					onOpenTaskChange={onOpenTaskChange}
					onRefresh={() => {}}
					onClose={() => {}}
				/>,
			);
		});

		expect(container.textContent).toContain("Backend");
		expect(container.textContent).toContain("Durable execution");
		expect(container.textContent).toContain("50%");
		expect(container.textContent).toContain("1 blocking");
		expect(container.textContent).toContain("Unassigned scope");

		const taskButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Persist acceptance receipts"),
		);
		const jjButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "jj",
		);
		if (!taskButton || !jjButton) {
			throw new Error("Expected task and jj navigation buttons.");
		}
		act(() => taskButton.click());
		act(() => jjButton.click());

		expect(onSelectTask).toHaveBeenCalledWith("task-1");
		expect(onOpenTaskChange).toHaveBeenCalledWith("task-1");
	});
});
