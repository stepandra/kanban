import type { RuntimeBoardCard, RuntimeBoardData } from "./api-contract";

/**
 * Dependency scheduler v1 (BA-16).
 *
 * A task is READY when it sits in the backlog column and no dependency edge references it as the
 * dependent (`fromTaskId`), i.e. all of its prerequisites have been resolved (trashed). The ready
 * queue is ordered by:
 *
 *   1. priority descending (`card.priority`, tasks without a priority default to 0),
 *   2. topology: tasks with a longer chain of dependants behind them first, so completing them
 *      unblocks the most follow-up work,
 *   3. `createdAt` ascending (oldest first), then board position as a stable tie-break.
 *
 * Integration note for the Fixer-dispatch path (wired up in `src/commands/task.ts` by separate
 * work — do not wire here): call `allocateReadyTaskIds(board, FIXER_DISPATCH_CAPACITY)` to pick
 * the task ids that may be auto-started within the Fixer's capacity of 2 concurrent tasks.
 */
export const FIXER_DISPATCH_CAPACITY = 2;

function normalizePriority(card: RuntimeBoardCard): number {
	return card.priority ?? 0;
}

// Maps each prerequisite task id to the length of the longest chain of dependants waiting behind
// it. Tasks nothing depends on have depth 0. Dependency cycles are rejected at link time, but the
// traversal guards against cyclic data defensively.
function buildDependantDepths(board: RuntimeBoardData): Map<string, number> {
	const dependantsByPrerequisite = new Map<string, string[]>();
	for (const dependency of board.dependencies) {
		const dependants = dependantsByPrerequisite.get(dependency.toTaskId) ?? [];
		dependants.push(dependency.fromTaskId);
		dependantsByPrerequisite.set(dependency.toTaskId, dependants);
	}
	const depths = new Map<string, number>();
	const visiting = new Set<string>();
	const depthOf = (taskId: string): number => {
		const cached = depths.get(taskId);
		if (cached !== undefined) {
			return cached;
		}
		if (visiting.has(taskId)) {
			return 0;
		}
		visiting.add(taskId);
		let depth = 0;
		for (const dependant of dependantsByPrerequisite.get(taskId) ?? []) {
			depth = Math.max(depth, 1 + depthOf(dependant));
		}
		visiting.delete(taskId);
		depths.set(taskId, depth);
		return depth;
	};
	for (const taskId of dependantsByPrerequisite.keys()) {
		depthOf(taskId);
	}
	return depths;
}

export function getReadyTaskQueue(board: RuntimeBoardData): RuntimeBoardCard[] {
	const backlogColumn = board.columns.find((column) => column.id === "backlog");
	if (!backlogColumn) {
		return [];
	}
	const blockedTaskIds = new Set(board.dependencies.map((dependency) => dependency.fromTaskId));
	const depths = buildDependantDepths(board);
	return backlogColumn.cards
		.map((card, index) => ({ card, index }))
		.filter((entry) => !blockedTaskIds.has(entry.card.id))
		.sort((first, second) => {
			const priorityDelta = normalizePriority(second.card) - normalizePriority(first.card);
			if (priorityDelta !== 0) {
				return priorityDelta;
			}
			const depthDelta = (depths.get(second.card.id) ?? 0) - (depths.get(first.card.id) ?? 0);
			if (depthDelta !== 0) {
				return depthDelta;
			}
			if (first.card.createdAt !== second.card.createdAt) {
				return first.card.createdAt - second.card.createdAt;
			}
			return first.index - second.index;
		})
		.map((entry) => entry.card);
}

export function allocateReadyTaskIds(board: RuntimeBoardData, capacity: number = FIXER_DISPATCH_CAPACITY): string[] {
	if (capacity <= 0) {
		return [];
	}
	return getReadyTaskQueue(board)
		.slice(0, capacity)
		.map((card) => card.id);
}
