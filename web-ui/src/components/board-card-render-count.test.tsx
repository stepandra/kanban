import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardColumn } from "@/components/board-column";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardColumn as BoardColumnModel } from "@/types";

const draggableRenderCounts = vi.hoisted(() => new Map<string, number>());

vi.mock("@hello-pangea/dnd", () => ({
	Draggable: ({
		children,
		draggableId,
	}: {
		children: (
			provided: {
				innerRef: (element: HTMLDivElement | null) => void;
				draggableProps: object;
				dragHandleProps: object;
			},
			snapshot: { isDragging: boolean },
		) => ReactNode;
		draggableId: string;
	}): React.ReactElement => {
		draggableRenderCounts.set(draggableId, (draggableRenderCounts.get(draggableId) ?? 0) + 1);
		return <>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>;
	},
	Droppable: ({
		children,
	}: {
		children: (provided: {
			innerRef: (element: HTMLDivElement | null) => void;
			droppableProps: object;
			placeholder: ReactNode;
		}) => ReactNode;
	}): React.ReactElement => <>{children({ innerRef: () => {}, droppableProps: {}, placeholder: null })}</>,
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => undefined,
}));

vi.mock("@/utils/react-use", () => ({
	useMedia: () => false,
	useMeasure: () => [
		() => {},
		{
			width: 240,
			height: 0,
			top: 0,
			left: 0,
			bottom: 0,
			right: 0,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		},
	],
}));

vi.mock("@/utils/text-measure", () => ({
	DEFAULT_TEXT_MEASURE_FONT: "400 14px sans-serif",
	measureTextWidth: (value: string) => value.length * 8,
	readElementFontShorthand: () => "400 14px sans-serif",
}));

function createCard(id: string, title: string): BoardCard {
	return {
		id,
		title,
		prompt: title,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createSessionSummary(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe("BoardCard memoization", () => {
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
		draggableRenderCounts.clear();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("does not re-render unchanged cards when another card's session state updates", async () => {
		const column: BoardColumnModel = {
			id: "review",
			title: "Review",
			cards: [createCard("task-a", "Task A"), createCard("task-b", "Task B")],
		};
		const columnProps = {
			onCommitTask: vi.fn(),
			onOpenPrTask: vi.fn(),
			onMoveToTrashTask: vi.fn(),
			onSaveTitle: vi.fn(),
			onCardClick: vi.fn(),
		};

		await act(async () => {
			root.render(<BoardColumn column={column} taskSessions={{}} {...columnProps} />);
		});

		expect(draggableRenderCounts.get("task-a")).toBe(1);
		expect(draggableRenderCounts.get("task-b")).toBe(1);

		// Stream tick: task-a gets a session summary, task-b's props are untouched.
		await act(async () => {
			root.render(
				<BoardColumn
					column={column}
					taskSessions={{ "task-a": createSessionSummary("task-a", "awaiting_review") }}
					{...columnProps}
				/>,
			);
		});

		expect(draggableRenderCounts.get("task-a")).toBe(2);
		expect(draggableRenderCounts.get("task-b")).toBe(1);

		// Stream tick: task-a's session state changes again; task-b stays memoized.
		await act(async () => {
			root.render(
				<BoardColumn
					column={column}
					taskSessions={{ "task-a": createSessionSummary("task-a", "failed") }}
					{...columnProps}
				/>,
			);
		});

		expect(draggableRenderCounts.get("task-a")).toBe(3);
		expect(draggableRenderCounts.get("task-b")).toBe(1);
	});
});
