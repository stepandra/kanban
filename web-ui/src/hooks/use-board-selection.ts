import { useCallback, useEffect, useMemo, useState } from "react";

import type { BoardData } from "@/types";

export interface UseBoardSelectionResult {
	selectedTaskIds: string[];
	selectedTaskIdSet: ReadonlySet<string>;
	isSelectionMode: boolean;
	setIsSelectionMode: (isSelectionMode: boolean) => void;
	toggleTaskSelected: (taskId: string) => void;
	clearSelection: () => void;
}

export function useBoardSelection(board: BoardData): UseBoardSelectionResult {
	const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
	const [isSelectionMode, setIsSelectionMode] = useState(false);

	// Drop selected ids that no longer exist on the board (workspace switch,
	// trash moves, external state hydration) so bulk actions never target stale tasks.
	useEffect(() => {
		const existingTaskIds = new Set<string>();
		for (const column of board.columns) {
			for (const card of column.cards) {
				existingTaskIds.add(card.id);
			}
		}
		setSelectedTaskIds((current) => {
			if (current.length === 0) {
				return current;
			}
			const next = current.filter((taskId) => existingTaskIds.has(taskId));
			return next.length === current.length ? current : next;
		});
	}, [board]);

	const toggleTaskSelected = useCallback((taskId: string) => {
		setSelectedTaskIds((current) =>
			current.includes(taskId) ? current.filter((currentTaskId) => currentTaskId !== taskId) : [...current, taskId],
		);
	}, []);

	const clearSelection = useCallback(() => {
		setSelectedTaskIds([]);
		setIsSelectionMode(false);
	}, []);

	const selectedTaskIdSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds]);

	return useMemo(
		() => ({
			selectedTaskIds,
			selectedTaskIdSet,
			isSelectionMode,
			setIsSelectionMode,
			toggleTaskSelected,
			clearSelection,
		}),
		[clearSelection, isSelectionMode, selectedTaskIds, selectedTaskIdSet, toggleTaskSelected],
	);
}
