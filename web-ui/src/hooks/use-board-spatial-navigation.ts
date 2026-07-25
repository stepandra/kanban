import { useCallback, useEffect, useState } from "react";

import type { BoardCard, BoardColumn, BoardColumnId } from "@/types";
import { isEventInsideDialog, isTypingTarget } from "@/utils/keyboard-target";
import { useWindowEvent } from "@/utils/react-use";

interface BoardSpatialPosition {
	columnIndex: number;
	cardIndex: number;
}

function findCardPosition(columns: BoardColumn[], taskId: string): BoardSpatialPosition | null {
	for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
		const cardIndex = columns[columnIndex]?.cards.findIndex((card) => card.id === taskId) ?? -1;
		if (cardIndex >= 0) {
			return { columnIndex, cardIndex };
		}
	}
	return null;
}

function scrollBoardCardIntoView(taskId: string): void {
	const boardElement = document.querySelector<HTMLElement>(".kb-board");
	if (!boardElement) {
		return;
	}
	for (const element of boardElement.querySelectorAll<HTMLElement>("[data-task-id]")) {
		if (element.dataset.taskId === taskId) {
			element.scrollIntoView({ block: "nearest" });
			return;
		}
	}
}

interface UseBoardSpatialNavigationInput {
	columns: BoardColumn[];
	enabled: boolean;
	hasSelection: boolean;
	onClearSelection: () => void;
	onActivateCard: (card: BoardCard, columnId: BoardColumnId) => void;
}

export function useBoardSpatialNavigation({
	columns,
	enabled,
	hasSelection,
	onClearSelection,
	onActivateCard,
}: UseBoardSpatialNavigationInput): { focusedTaskId: string | null } {
	const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);

	useEffect(() => {
		if (focusedTaskId && !findCardPosition(columns, focusedTaskId)) {
			setFocusedTaskId(null);
		}
	}, [columns, focusedTaskId]);

	useEffect(() => {
		if (focusedTaskId) {
			scrollBoardCardIntoView(focusedTaskId);
		}
	}, [focusedTaskId]);

	const moveFocus = useCallback(
		(direction: "up" | "down" | "left" | "right") => {
			const navigableColumns = columns
				.map((column, columnIndex) => ({ column, columnIndex }))
				.filter(({ column }) => column.cards.length > 0);
			if (navigableColumns.length === 0) {
				return;
			}
			const current = focusedTaskId ? findCardPosition(columns, focusedTaskId) : null;
			if (!current) {
				const target =
					direction === "up" || direction === "left"
						? navigableColumns[navigableColumns.length - 1]
						: navigableColumns[0];
				if (!target) {
					return;
				}
				const cardIndex = direction === "up" || direction === "left" ? target.column.cards.length - 1 : 0;
				setFocusedTaskId(target.column.cards[cardIndex]?.id ?? null);
				return;
			}
			if (direction === "up" || direction === "down") {
				const column = columns[current.columnIndex];
				const cardCount = column?.cards.length ?? 0;
				if (cardCount === 0) {
					return;
				}
				const delta = direction === "down" ? 1 : -1;
				const nextCardIndex = Math.min(Math.max(current.cardIndex + delta, 0), cardCount - 1);
				setFocusedTaskId(column?.cards[nextCardIndex]?.id ?? null);
				return;
			}
			const currentNavigableIndex = navigableColumns.findIndex(
				({ columnIndex }) => columnIndex === current.columnIndex,
			);
			const target = navigableColumns[currentNavigableIndex + (direction === "right" ? 1 : -1)];
			if (!target) {
				return;
			}
			const nextCardIndex = Math.min(current.cardIndex, target.column.cards.length - 1);
			setFocusedTaskId(target.column.cards[nextCardIndex]?.id ?? null);
		},
		[columns, focusedTaskId],
	);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (!enabled || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
				return;
			}
			if (isTypingTarget(event.target) || isEventInsideDialog(event.target)) {
				return;
			}
			switch (event.key) {
				case "ArrowDown":
					event.preventDefault();
					moveFocus("down");
					return;
				case "ArrowUp":
					event.preventDefault();
					moveFocus("up");
					return;
				case "ArrowLeft":
					event.preventDefault();
					moveFocus("left");
					return;
				case "ArrowRight":
					event.preventDefault();
					moveFocus("right");
					return;
				case "Enter": {
					if (!focusedTaskId) {
						return;
					}
					const position = findCardPosition(columns, focusedTaskId);
					const column = position ? columns[position.columnIndex] : null;
					const card = position ? column?.cards[position.cardIndex] : null;
					if (column && card) {
						event.preventDefault();
						onActivateCard(card, column.id);
					}
					return;
				}
				case "Escape": {
					if (hasSelection) {
						event.preventDefault();
						onClearSelection();
						return;
					}
					if (focusedTaskId) {
						event.preventDefault();
						setFocusedTaskId(null);
					}
					return;
				}
			}
		},
		[columns, enabled, focusedTaskId, hasSelection, moveFocus, onActivateCard, onClearSelection],
	);
	useWindowEvent("keydown", handleKeyDown);

	return { focusedTaskId };
}
