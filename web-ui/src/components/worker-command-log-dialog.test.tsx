import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkerCommandLogDialog } from "@/components/worker-command-log-dialog";

const queryMocks = vi.hoisted(() => ({
	refetch: vi.fn(async () => null),
}));

vi.mock("@/runtime/use-trpc-query", () => ({
	useTrpcQuery: () => ({
		data: {
			generatedAt: 1_000,
			entries: [
				{
					id: "1000-1",
					taskId: "task-1",
					agentId: "codex",
					cwd: "/tmp/task-1",
					command: ["zmx", "attach", "kanban.workspace.codex.task-1.0123456789ab", "codex", "<task-prompt>"],
					status: "started",
					pid: 4321,
					startedAt: 1_000,
					error: null,
				},
			],
		},
		isLoading: false,
		isError: false,
		error: null,
		refetch: queryMocks.refetch,
		setData: vi.fn(),
	}),
}));

describe("WorkerCommandLogDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows the actual sanitized command and navigates to its task", async () => {
		const onOpenChange = vi.fn();
		const onSelectTask = vi.fn();

		await act(async () => {
			root.render(
				<WorkerCommandLogDialog
					open
					onOpenChange={onOpenChange}
					workspaceId="workspace-1"
					board={{
						columns: [
							{ id: "backlog", title: "Backlog", cards: [] },
							{
								id: "in_progress",
								title: "In Progress",
								cards: [
									{
										id: "task-1",
										title: "Ship worker observability",
										prompt: "Implement it",
										startInPlanMode: false,
										baseRef: "main",
										createdAt: 1,
										updatedAt: 1,
									},
								],
							},
							{ id: "review", title: "Review", cards: [] },
							{ id: "trash", title: "Done", cards: [] },
						],
						dependencies: [],
					}}
					onSelectTask={onSelectTask}
				/>,
			);
		});

		expect(document.body.textContent).toContain("Worker commands");
		expect(document.body.textContent).toContain("zmx attach kanban.workspace.codex.task-1.0123456789ab codex");
		expect(document.body.textContent).toContain("'<task-prompt>'");
		expect(document.body.textContent).toContain("Ship worker observability");

		const taskButton = document.body.querySelector<HTMLButtonElement>('button[title="Ship worker observability"]');
		await act(async () => {
			taskButton?.click();
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onSelectTask).toHaveBeenCalledWith("task-1");
	});
});
