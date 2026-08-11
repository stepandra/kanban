import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeTaskExecutionAttemptReference,
	RuntimeTaskImage,
	RuntimeTaskOrigin,
} from "./api-contract";
import { incrementTaskGeneration, resolveTaskGeneration } from "./task-execution-reference";
import { createUniqueTaskId } from "./task-id";
import { resolveTaskTitle } from "./task-title";

export interface RuntimeCreateTaskInput {
	taskId?: string;
	title?: string;
	prompt: string;
	startInPlanMode?: boolean;
	images?: RuntimeTaskImage[];
	agentId?: RuntimeAgentId;
	priority?: number;
	origin?: RuntimeTaskOrigin;
	baseRef: string;
}

export interface RuntimeUpdateTaskInput {
	title?: string;
	prompt: string;
	startInPlanMode?: boolean;
	images?: RuntimeTaskImage[];
	agentId?: RuntimeAgentId | null;
	priority?: number | null;
	baseRef: string;
}

// Copy image metadata so board tasks do not retain caller-owned array or object references.
function cloneTaskImages(images?: RuntimeTaskImage[]): RuntimeTaskImage[] | undefined {
	return images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined;
}

function areTaskImagesEqual(left: RuntimeTaskImage[] | undefined, right: RuntimeTaskImage[] | undefined): boolean {
	if (left === right) {
		return true;
	}
	if (!left || !right || left.length !== right.length) {
		return false;
	}
	return left.every((image, index) => {
		const candidate = right[index];
		return (
			candidate !== undefined &&
			image.id === candidate.id &&
			image.data === candidate.data &&
			image.mimeType === candidate.mimeType &&
			image.name === candidate.name
		);
	});
}

export interface RuntimeTaskExecutionContract {
	prompt: string;
	startInPlanMode: boolean;
	images?: RuntimeTaskImage[];
	agentId?: RuntimeAgentId;
	removedAgentId?: "cline";
	baseRef: string;
}

export function resolveUpdatedTaskGeneration(
	task: Pick<
		RuntimeBoardCard,
		"generation" | "prompt" | "startInPlanMode" | "images" | "agentId" | "removedAgentId" | "baseRef"
	>,
	nextContract: RuntimeTaskExecutionContract,
): number {
	const executionContractChanged =
		task.prompt !== nextContract.prompt ||
		task.startInPlanMode !== nextContract.startInPlanMode ||
		!areTaskImagesEqual(task.images, nextContract.images) ||
		task.agentId !== nextContract.agentId ||
		task.removedAgentId !== nextContract.removedAgentId ||
		task.baseRef !== nextContract.baseRef;
	return executionContractChanged ? incrementTaskGeneration(task.generation) : resolveTaskGeneration(task.generation);
}

export interface RuntimeCreateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard;
}

export interface RuntimeMoveTaskResult {
	moved: boolean;
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	fromColumnId: RuntimeBoardColumnId | null;
}

export interface RuntimeUpdateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	updated: boolean;
}

export interface RuntimeRecordTaskExecutionAttemptResult extends RuntimeUpdateTaskResult {
	recorded: boolean;
	reason?: "missing_task" | "generation_mismatch";
}

export interface RuntimeAddTaskDependencyResult {
	board: RuntimeBoardData;
	added: boolean;
	reason?: "missing_task" | "same_task" | "duplicate" | "trash_task" | "non_backlog" | "cycle" | "task_admitted";
	dependency?: RuntimeBoardDependency;
}

export interface RuntimeRemoveTaskDependencyResult {
	board: RuntimeBoardData;
	removed: boolean;
}

export interface RuntimeDeleteTasksResult {
	board: RuntimeBoardData;
	deleted: boolean;
	deletedTaskIds: string[];
	blockedTaskIds: string[];
}

function collectExistingTaskIds(board: RuntimeBoardData): Set<string> {
	const existingIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			existingIds.add(card.id);
		}
	}
	return existingIds;
}

function collectTaskIds(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function createDependencyId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

function createDependencyPairKey(backlogTaskId: string, linkedTaskId: string): string {
	return `${backlogTaskId}::${linkedTaskId}`;
}

function hasDependencyPair(board: RuntimeBoardData, backlogTaskId: string, linkedTaskId: string): boolean {
	const pairKey = createDependencyPairKey(backlogTaskId, linkedTaskId);
	for (const dependency of board.dependencies) {
		const existing = resolveDependencyEndpoints(board, dependency.fromTaskId, dependency.toTaskId);
		if ("reason" in existing) {
			continue;
		}
		if (createDependencyPairKey(existing.backlogTaskId, existing.linkedTaskId) === pairKey) {
			return true;
		}
	}
	return false;
}

// Dependency edges point from the dependent (backlog) task to its prerequisite. Adding an edge
// backlogTaskId -> linkedTaskId would create a cycle when linkedTaskId can already reach
// backlogTaskId by following existing edges, because the two tasks would then wait on each other.
function wouldCreateDependencyCycle(board: RuntimeBoardData, backlogTaskId: string, linkedTaskId: string): boolean {
	const prerequisitesByDependant = new Map<string, string[]>();
	for (const dependency of board.dependencies) {
		const prerequisites = prerequisitesByDependant.get(dependency.fromTaskId) ?? [];
		prerequisites.push(dependency.toTaskId);
		prerequisitesByDependant.set(dependency.fromTaskId, prerequisites);
	}
	const visited = new Set<string>();
	const pending = [linkedTaskId];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) {
			continue;
		}
		if (current === backlogTaskId) {
			return true;
		}
		if (visited.has(current)) {
			continue;
		}
		visited.add(current);
		for (const prerequisite of prerequisitesByDependant.get(current) ?? []) {
			pending.push(prerequisite);
		}
	}
	return false;
}

function findTaskLocation(
	board: RuntimeBoardData,
	taskId: string,
): {
	columnIndex: number;
	taskIndex: number;
	columnId: RuntimeBoardColumnId;
	task: RuntimeBoardCard;
} | null {
	for (const [columnIndex, column] of board.columns.entries()) {
		const taskIndex = column.cards.findIndex((card) => card.id === taskId);
		if (taskIndex === -1) {
			continue;
		}
		const task = column.cards[taskIndex];
		if (!task) {
			continue;
		}
		return {
			columnIndex,
			taskIndex,
			columnId: column.id,
			task,
		};
	}
	return null;
}

function resolveDependencyEndpoints(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
):
	| {
			backlogTaskId: string;
			linkedTaskId: string;
	  }
	| { reason: RuntimeAddTaskDependencyResult["reason"] } {
	const firstColumnId = getTaskColumnId(board, firstTaskId);
	const secondColumnId = getTaskColumnId(board, secondTaskId);
	if (!firstColumnId || !secondColumnId) {
		return { reason: "missing_task" };
	}
	const firstIsBacklog = firstColumnId === "backlog";
	const secondIsBacklog = secondColumnId === "backlog";
	if (firstIsBacklog && secondIsBacklog) {
		return {
			backlogTaskId: firstTaskId,
			linkedTaskId: secondTaskId,
		};
	}
	if (!firstIsBacklog && !secondIsBacklog) {
		return { reason: "non_backlog" };
	}
	return firstIsBacklog
		? { backlogTaskId: firstTaskId, linkedTaskId: secondTaskId }
		: { backlogTaskId: secondTaskId, linkedTaskId: firstTaskId };
}

export function updateTaskDependencies(board: RuntimeBoardData): RuntimeBoardData {
	if (board.dependencies.length === 0) {
		return board;
	}
	const taskIds = collectTaskIds(board);
	const dependencies: RuntimeBoardDependency[] = [];
	const existingPairs = new Set<string>();
	for (const dependency of board.dependencies) {
		const firstTaskId = dependency.fromTaskId.trim();
		const secondTaskId = dependency.toTaskId.trim();
		if (!firstTaskId || !secondTaskId || firstTaskId === secondTaskId) {
			continue;
		}
		if (!taskIds.has(firstTaskId) || !taskIds.has(secondTaskId)) {
			continue;
		}
		const pairKey = createDependencyPairKey(firstTaskId, secondTaskId);
		if (existingPairs.has(pairKey)) {
			continue;
		}
		if (wouldCreateDependencyCycle({ ...board, dependencies }, firstTaskId, secondTaskId)) {
			continue;
		}
		existingPairs.add(pairKey);
		dependencies.push({
			id: dependency.id,
			fromTaskId: firstTaskId,
			toTaskId: secondTaskId,
			createdAt: dependency.createdAt,
		});
	}
	if (
		dependencies.length === board.dependencies.length &&
		dependencies.every((dependency, index) => {
			const current = board.dependencies[index];
			return (
				current &&
				current.id === dependency.id &&
				current.fromTaskId === dependency.fromTaskId &&
				current.toTaskId === dependency.toTaskId &&
				current.createdAt === dependency.createdAt
			);
		})
	) {
		return board;
	}
	return {
		...board,
		dependencies,
	};
}

export function addTaskToColumn(
	board: RuntimeBoardData,
	columnId: RuntimeBoardColumnId,
	input: RuntimeCreateTaskInput,
	randomUuid: () => string,
	now: number = Date.now(),
): RuntimeCreateTaskResult {
	const prompt = input.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt is required.");
	}
	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task baseRef is required.");
	}
	const existingIds = collectExistingTaskIds(board);
	const explicitTaskId = input.taskId?.trim();
	if (explicitTaskId && existingIds.has(explicitTaskId)) {
		throw new Error(`Task "${explicitTaskId}" already exists.`);
	}
	const task: RuntimeBoardCard = {
		id: explicitTaskId || createUniqueTaskId(existingIds, randomUuid),
		title: resolveTaskTitle(input.title, prompt),
		prompt,
		startInPlanMode: Boolean(input.startInPlanMode),
		images: cloneTaskImages(input.images),
		...(input.agentId ? { agentId: input.agentId } : {}),
		...(input.priority !== undefined ? { priority: input.priority } : {}),
		generation: 1,
		...(input.origin ? { origin: { ...input.origin } } : {}),
		baseRef,
		createdAt: now,
		updatedAt: now,
	};

	const targetColumnIndex = board.columns.findIndex((column) => column.id === columnId);
	if (targetColumnIndex === -1) {
		throw new Error(`Column ${columnId} not found.`);
	}

	const columns = board.columns.map((column, index) => {
		if (index !== targetColumnIndex) {
			return column;
		}
		return {
			...column,
			cards: [task, ...column.cards],
		};
	});

	return {
		board: {
			...board,
			columns,
		},
		task,
	};
}

export function getTaskColumnId(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return null;
	}
	const found = findTaskLocation(board, normalizedTaskId);
	return found ? found.columnId : null;
}

export function recordTaskExecutionAttempt(
	board: RuntimeBoardData,
	taskId: string,
	execution: RuntimeTaskExecutionAttemptReference,
	now: number = Date.now(),
): RuntimeRecordTaskExecutionAttemptResult {
	const normalizedTaskId = taskId.trim();
	const location = normalizedTaskId ? findTaskLocation(board, normalizedTaskId) : null;
	if (!location) {
		return { board, task: null, recorded: false, updated: false, reason: "missing_task" };
	}
	if (resolveTaskGeneration(location.task.generation) !== execution.generation) {
		return {
			board,
			task: location.task,
			recorded: false,
			updated: false,
			reason: "generation_mismatch",
		};
	}
	if (
		location.task.execution?.attemptId === execution.attemptId &&
		location.task.execution.generation === execution.generation &&
		location.task.execution.queuedAt === execution.queuedAt
	) {
		return { board, task: location.task, recorded: true, updated: false };
	}
	if (
		location.task.execution?.generation === execution.generation &&
		location.task.execution.queuedAt > execution.queuedAt
	) {
		return { board, task: location.task, recorded: true, updated: false };
	}

	const task: RuntimeBoardCard = {
		...location.task,
		execution: { ...execution },
		updatedAt: now,
	};
	const columns = board.columns.map((column, columnIndex) =>
		columnIndex === location.columnIndex
			? {
					...column,
					cards: column.cards.map((card, taskIndex) => (taskIndex === location.taskIndex ? task : card)),
				}
			: column,
	);
	return {
		board: { ...board, columns },
		task,
		recorded: true,
		updated: true,
	};
}

export function addTaskDependency(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
): RuntimeAddTaskDependencyResult {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId) {
		return { board, added: false, reason: "missing_task" };
	}
	if (normalizedFirstTaskId === normalizedSecondTaskId) {
		return { board, added: false, reason: "same_task" };
	}
	if (
		getTaskColumnId(board, normalizedFirstTaskId) === "trash" ||
		getTaskColumnId(board, normalizedSecondTaskId) === "trash"
	) {
		return { board, added: false, reason: "trash_task" };
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return { board, added: false, reason: resolved.reason };
	}
	if (findTaskLocation(board, resolved.backlogTaskId)?.task.execution) {
		return { board, added: false, reason: "task_admitted" };
	}
	if (hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId)) {
		return { board, added: false, reason: "duplicate" };
	}
	if (wouldCreateDependencyCycle(board, resolved.backlogTaskId, resolved.linkedTaskId)) {
		return { board, added: false, reason: "cycle" };
	}
	const dependency: RuntimeBoardDependency = {
		id: createDependencyId(),
		fromTaskId: resolved.backlogTaskId,
		toTaskId: resolved.linkedTaskId,
		createdAt: Date.now(),
	};
	return {
		board: {
			...board,
			dependencies: [...board.dependencies, dependency],
		},
		added: true,
		dependency,
	};
}

export function canAddTaskDependency(board: RuntimeBoardData, firstTaskId: string, secondTaskId: string): boolean {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId || normalizedFirstTaskId === normalizedSecondTaskId) {
		return false;
	}
	if (
		getTaskColumnId(board, normalizedFirstTaskId) === "trash" ||
		getTaskColumnId(board, normalizedSecondTaskId) === "trash"
	) {
		return false;
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return false;
	}
	return (
		!findTaskLocation(board, resolved.backlogTaskId)?.task.execution &&
		!hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId) &&
		!wouldCreateDependencyCycle(board, resolved.backlogTaskId, resolved.linkedTaskId)
	);
}

export function removeTaskDependency(board: RuntimeBoardData, dependencyId: string): RuntimeRemoveTaskDependencyResult {
	const dependencies = board.dependencies.filter((dependency) => dependency.id !== dependencyId);
	if (dependencies.length === board.dependencies.length) {
		return { board, removed: false };
	}
	return {
		board: {
			...board,
			dependencies,
		},
		removed: true,
	};
}

export function discardTask(board: RuntimeBoardData, taskId: string, now: number = Date.now()): RuntimeMoveTaskResult {
	return moveTaskToColumnInternal(board, taskId, "trash", now);
}

export function deleteTasksFromBoard(board: RuntimeBoardData, taskIds: Iterable<string>): RuntimeDeleteTasksResult {
	const normalizedTaskIds = new Set(
		Array.from(taskIds, (taskId) => taskId.trim()).filter((taskId) => taskId.length > 0),
	);
	if (normalizedTaskIds.size === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
			blockedTaskIds: [],
		};
	}
	const blockedTaskIds = Array.from(
		new Set(
			board.dependencies.flatMap((dependency) => {
				const deletesFrom = normalizedTaskIds.has(dependency.fromTaskId);
				const deletesTo = normalizedTaskIds.has(dependency.toTaskId);
				if (deletesFrom === deletesTo) {
					return [];
				}
				return deletesFrom ? [dependency.fromTaskId] : [dependency.toTaskId];
			}),
		),
	).sort();
	if (blockedTaskIds.length > 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
			blockedTaskIds,
		};
	}

	const deletedTaskIds: string[] = [];
	const columns = board.columns.map((column) => {
		const remainingCards = column.cards.filter((card) => {
			if (!normalizedTaskIds.has(card.id)) {
				return true;
			}
			deletedTaskIds.push(card.id);
			return false;
		});
		return remainingCards.length === column.cards.length ? column : { ...column, cards: remainingCards };
	});

	if (deletedTaskIds.length === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
			blockedTaskIds: [],
		};
	}

	const deletedTaskIdSet = new Set(deletedTaskIds);
	const dependencies = board.dependencies.filter(
		(dependency) => !deletedTaskIdSet.has(dependency.fromTaskId) && !deletedTaskIdSet.has(dependency.toTaskId),
	);

	return {
		board: {
			...board,
			columns,
			dependencies,
		},
		deleted: true,
		deletedTaskIds,
		blockedTaskIds: [],
	};
}

export function moveTaskToColumn(
	board: RuntimeBoardData,
	taskId: string,
	targetColumnId: RuntimeBoardColumnId,
	now: number = Date.now(),
): RuntimeMoveTaskResult {
	const found = findTaskLocation(board, taskId.trim());
	if (
		found?.columnId === "backlog" &&
		targetColumnId === "in_progress" &&
		board.dependencies.some((dependency) => dependency.fromTaskId === found.task.id)
	) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	if (found?.columnId === "review" && targetColumnId === "trash") {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	return moveTaskToColumnInternal(board, taskId, targetColumnId, now);
}

function moveTaskToColumnInternal(
	board: RuntimeBoardData,
	taskId: string,
	targetColumnId: RuntimeBoardColumnId,
	now: number,
): RuntimeMoveTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}

	const found = findTaskLocation(board, normalizedTaskId);
	if (!found) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}
	if (found.columnId === targetColumnId) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const targetColumnIndex = board.columns.findIndex((column) => column.id === targetColumnId);
	if (targetColumnIndex === -1) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceColumn = board.columns[found.columnIndex];
	const targetColumn = board.columns[targetColumnIndex];
	if (!sourceColumn || !targetColumn) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceCards = [...sourceColumn.cards];
	const [task] = sourceCards.splice(found.taskIndex, 1);
	if (!task) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const movedTask: RuntimeBoardCard = {
		...task,
		updatedAt: now,
	};
	if (targetColumnId === "trash") {
		delete movedTask.execution;
	}
	if (found.columnId === "trash" && targetColumnId === "review") {
		delete movedTask.acceptanceEvidence;
	}
	const targetCards =
		targetColumnId === "trash" ? [movedTask, ...targetColumn.cards] : [...targetColumn.cards, movedTask];

	const columns = board.columns.map((column, index) => {
		if (index === found.columnIndex) {
			return {
				...column,
				cards: sourceCards,
			};
		}
		if (index === targetColumnIndex) {
			return {
				...column,
				cards: targetCards,
			};
		}
		return column;
	});

	return {
		moved: true,
		board: updateTaskDependencies({
			...board,
			columns,
		}),
		task: movedTask,
		fromColumnId: found.columnId,
	};
}

export function updateTask(
	board: RuntimeBoardData,
	taskId: string,
	input: RuntimeUpdateTaskInput,
	now: number = Date.now(),
): RuntimeUpdateTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const prompt = input.prompt.trim();
	if (!prompt) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	let updatedTask: RuntimeBoardCard | null = null;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== normalizedTaskId) {
				return card;
			}
			const images = input.images === undefined ? card.images : cloneTaskImages(input.images);
			const agentId = input.agentId === undefined ? card.agentId : (input.agentId ?? undefined);
			const removedAgentId = input.agentId === undefined ? card.removedAgentId : undefined;
			const startInPlanMode = Boolean(input.startInPlanMode);
			const generation = resolveUpdatedTaskGeneration(card, {
				prompt,
				startInPlanMode,
				images,
				agentId,
				removedAgentId,
				baseRef,
			});
			columnUpdated = true;
			updatedTask = {
				...card,
				title: resolveTaskTitle(input.title, prompt),
				prompt,
				startInPlanMode,
				images,
				agentId,
				removedAgentId,
				priority: input.priority === undefined ? card.priority : (input.priority ?? undefined),
				generation,
				execution: generation === resolveTaskGeneration(card.generation) ? card.execution : undefined,
				baseRef,
				updatedAt: now,
			};
			return updatedTask;
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updatedTask) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	return {
		board: {
			...board,
			columns,
		},
		task: updatedTask,
		updated: true,
	};
}
