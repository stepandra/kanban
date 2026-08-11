import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanBoard } from "@/components/kanban-board";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

const captured = vi.hoisted(() => ({
	columns: {} as Record<
		string,
		{
			cardIds: string[];
			keyboardFocusedTaskId: string | null;
			selectedTaskIds: string[];
			onToggleCardSelected?: (taskId: string) => void;
		}
	>,
}));

vi.mock("@hello-pangea/dnd", () => ({
	DragDropContext: ({ children }: { children: ReactNode }): React.ReactElement => <>{children}</>,
}));

vi.mock("@/components/board-column", () => ({
	BoardColumn: (props: {
		column: { id: string; cards: { id: string }[] };
		keyboardFocusedTaskId?: string | null;
		selectedTaskIds?: ReadonlySet<string>;
		onToggleCardSelected?: (taskId: string) => void;
	}): React.ReactElement => {
		captured.columns[props.column.id] = {
			cardIds: props.column.cards.map((card) => card.id),
			keyboardFocusedTaskId: props.keyboardFocusedTaskId ?? null,
			selectedTaskIds: [...(props.selectedTaskIds ?? new Set<string>())],
			onToggleCardSelected: props.onToggleCardSelected,
		};
		return (
			<section data-column-id={props.column.id}>
				<div className="kb-column-cards" />
			</section>
		);
	},
}));

vi.mock("@/components/dependencies/dependency-overlay", () => ({
	DependencyOverlay: (): null => null,
}));

vi.mock("@/components/dependencies/use-dependency-linking", () => ({
	useDependencyLinking: () => ({
		draft: null,
		onDependencyPointerDown: vi.fn(),
		onDependencyPointerEnter: vi.fn(),
	}),
}));

function createCard(id: string, title: string): BoardCard {
	return {
		id,
		title,
		prompt: `${title} prompt`,
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

function createBoard(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [createCard("task-1", "Fix login bug")] },
			{ id: "in_progress", title: "In Progress", cards: [createCard("task-2", "Build feature")] },
			{ id: "review", title: "Review", cards: [createCard("task-3", "Polish UI")] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
	setter?.call(select, value);
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

function pressKey(key: string, target?: HTMLElement | Document | Window): void {
	(target ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("KanbanBoard toolbar (filter, selection, keyboard navigation)", () => {
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
		captured.columns = {};
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

	function getFilterInput(): HTMLInputElement {
		const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter tasks"]');
		if (!input) {
			throw new Error("Expected the board filter input to be rendered.");
		}
		return input;
	}

	async function renderBoard(props?: {
		onCardSelect?: (taskId: string) => void;
		onEditTask?: (card: BoardCard) => void;
		onMoveTasksToColumn?: (taskIds: string[], toColumnId: BoardColumnId) => void;
		data?: BoardData;
	}): Promise<void> {
		await act(async () => {
			root.render(
				<KanbanBoard
					data={props?.data ?? createBoard()}
					taskSessions={{ "task-2": createSessionSummary("task-2", "running") }}
					onCardSelect={props?.onCardSelect ?? (() => {})}
					onCreateTask={() => {}}
					onEditTask={props?.onEditTask}
					onMoveTasksToColumn={props?.onMoveTasksToColumn}
					dependencies={[]}
					onDragEnd={() => {}}
				/>,
			);
		});
	}

	it("hides filtered-out cards across all columns and shows an empty state", async () => {
		await renderBoard();

		expect(captured.columns.backlog?.cardIds).toEqual(["task-1"]);
		expect(captured.columns.in_progress?.cardIds).toEqual(["task-2"]);

		await act(async () => {
			setInputValue(getFilterInput(), "login");
		});

		expect(captured.columns.backlog?.cardIds).toEqual(["task-1"]);
		expect(captured.columns.in_progress?.cardIds).toEqual([]);
		expect(captured.columns.review?.cardIds).toEqual([]);
		expect(container.textContent).not.toContain("No tasks match the current filters.");

		await act(async () => {
			setInputValue(getFilterInput(), "no-such-task");
		});

		expect(captured.columns.backlog?.cardIds).toEqual([]);
		expect(container.textContent).toContain("No tasks match the current filters.");

		await act(async () => {
			pressKey("Escape", getFilterInput());
		});

		expect(captured.columns.backlog?.cardIds).toEqual(["task-1"]);
		expect(captured.columns.in_progress?.cardIds).toEqual(["task-2"]);
		expect(container.textContent).not.toContain("No tasks match the current filters.");
	});

	it("focuses the filter input with the / hotkey", async () => {
		await renderBoard();

		await act(async () => {
			// react-hotkeys-hook matches on event.code, not event.key.
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "/", code: "Slash", bubbles: true, cancelable: true }),
			);
		});

		expect(document.activeElement).toBe(getFilterInput());
	});

	it("filters by session state and by agent", async () => {
		await renderBoard();

		const stateSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by session state"]');
		if (!stateSelect) {
			throw new Error("Expected the session state filter select to be rendered.");
		}
		await act(async () => {
			setSelectValue(stateSelect, "running");
		});

		expect(captured.columns.backlog?.cardIds).toEqual([]);
		expect(captured.columns.in_progress?.cardIds).toEqual(["task-2"]);
		expect(captured.columns.review?.cardIds).toEqual([]);

		const agentSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by agent"]');
		if (!agentSelect) {
			throw new Error("Expected the agent filter select to be rendered.");
		}
		await act(async () => {
			setSelectValue(agentSelect, "");
		});

		expect(captured.columns.in_progress?.cardIds).toEqual(["task-2"]);
	});

	it("supports multi-select and a single-confirmed bulk discard", async () => {
		const onMoveTasksToColumn = vi.fn();
		await renderBoard({ onMoveTasksToColumn });

		await act(async () => {
			captured.columns.backlog?.onToggleCardSelected?.("task-1");
			captured.columns.review?.onToggleCardSelected?.("task-3");
		});

		expect(captured.columns.backlog?.selectedTaskIds).toEqual(["task-1", "task-3"]);
		expect(container.textContent).toContain("2 selected");

		const moveSelect = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Move selected tasks to column"]',
		);
		if (!moveSelect) {
			throw new Error("Expected the bulk move select to be rendered.");
		}
		await act(async () => {
			setSelectValue(moveSelect, "trash");
		});

		const dialog = document.body.querySelector("[role='alertdialog']");
		expect(dialog?.textContent).toContain("Discard 2 tasks?");

		const confirmButton = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent === "Discard",
		);
		if (!confirmButton) {
			throw new Error("Expected the bulk move confirmation button to be rendered.");
		}
		await act(async () => {
			confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		});

		expect(onMoveTasksToColumn).toHaveBeenCalledTimes(1);
		expect(onMoveTasksToColumn).toHaveBeenCalledWith(["task-1", "task-3"], "trash");
		expect(container.textContent).not.toContain("2 selected");
	});

	it("bulk-starts the selected backlog cards without a confirmation", async () => {
		const onMoveTasksToColumn = vi.fn();
		await renderBoard({ onMoveTasksToColumn });

		await act(async () => {
			captured.columns.backlog?.onToggleCardSelected?.("task-1");
		});

		const startButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Start");
		if (!startButton) {
			throw new Error("Expected the bulk Start button to be rendered.");
		}
		await act(async () => {
			startButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		});

		expect(onMoveTasksToColumn).toHaveBeenCalledWith(["task-1"], "in_progress");
		expect(document.body.querySelector("[role='alertdialog']")).toBeNull();
	});

	it("clears the selection when the selected tasks leave the board", async () => {
		await renderBoard();

		await act(async () => {
			captured.columns.backlog?.onToggleCardSelected?.("task-1");
		});
		expect(container.textContent).toContain("1 selected");

		const nextBoard = createBoard();
		nextBoard.columns[0] = { id: "backlog", title: "Backlog", cards: [createCard("task-9", "Other task")] };
		await renderBoard({ data: nextBoard });

		expect(container.textContent).not.toContain("selected");
	});

	it("navigates cards with arrow keys, activates with Enter, and clears with Esc", async () => {
		const onCardSelect = vi.fn();
		const onEditTask = vi.fn();
		await renderBoard({ onCardSelect, onEditTask });

		await act(async () => {
			pressKey("ArrowDown");
		});
		expect(captured.columns.backlog?.keyboardFocusedTaskId).toBe("task-1");

		await act(async () => {
			pressKey("ArrowRight");
		});
		expect(captured.columns.in_progress?.keyboardFocusedTaskId).toBe("task-2");

		await act(async () => {
			pressKey("ArrowRight");
		});
		expect(captured.columns.review?.keyboardFocusedTaskId).toBe("task-3");

		await act(async () => {
			pressKey("Enter");
		});
		expect(onCardSelect).toHaveBeenCalledWith("task-3");
		expect(onEditTask).not.toHaveBeenCalled();

		await act(async () => {
			pressKey("ArrowLeft");
		});
		await act(async () => {
			pressKey("ArrowLeft");
		});
		expect(captured.columns.backlog?.keyboardFocusedTaskId).toBe("task-1");

		await act(async () => {
			pressKey("Enter");
		});
		expect(onEditTask).toHaveBeenCalledTimes(1);

		await act(async () => {
			pressKey("Escape");
		});
		expect(captured.columns.backlog?.keyboardFocusedTaskId).toBeNull();
	});

	it("clears the selection with Esc before clearing keyboard focus", async () => {
		await renderBoard();

		await act(async () => {
			pressKey("ArrowDown");
		});
		await act(async () => {
			captured.columns.backlog?.onToggleCardSelected?.("task-1");
		});
		expect(container.textContent).toContain("1 selected");

		await act(async () => {
			pressKey("Escape");
		});
		expect(container.textContent).not.toContain("1 selected");

		await act(async () => {
			pressKey("Escape");
		});
		expect(captured.columns.backlog?.keyboardFocusedTaskId).toBeNull();
	});
});
