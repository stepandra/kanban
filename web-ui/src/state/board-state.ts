import type { DropResult } from "@hello-pangea/dnd";
import {
	runtimeTaskAcceptanceEvidenceSchema,
	runtimeTaskDeliverableKindSchema,
	runtimeTaskReviewSubmissionSchema,
} from "@runtime-contract";
import { createShortTaskId } from "@runtime-task-id";
import * as runtimeTaskState from "@runtime-task-state";

import { createInitialBoardData } from "@/data/board-data";
import type { RuntimeAgentId, RuntimeTaskAcceptanceEvidence, RuntimeTaskOrigin } from "@/runtime/types";
import { isAllowedCrossColumnCardMove, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type {
	BoardCard,
	BoardColumn,
	BoardColumnId,
	BoardData,
	BoardDependency,
	CardSelection,
	TaskImage,
} from "@/types";

export interface TaskDraft {
	title?: string;
	prompt: string;
	startInPlanMode?: boolean;
	images?: TaskImage[];
	agentId?: RuntimeAgentId;
	baseRef: string;
}

export interface TaskMoveEvent {
	taskId: string;
	fromColumnId: BoardColumnId;
	toColumnId: BoardColumnId;
}

function reorder<T>(list: T[], startIndex: number, endIndex: number): T[] {
	const result = Array.from(list);
	const [removed] = result.splice(startIndex, 1);
	if (removed !== undefined) {
		result.splice(endIndex, 0, removed);
	}
	return result;
}

function updateTaskTimestamp(task: BoardCard): BoardCard {
	return {
		...task,
		updatedAt: Date.now(),
	};
}

function withUpdatedColumns(board: BoardData, columns: BoardColumn[]): BoardData {
	return {
		...board,
		columns,
	};
}

function normalizeColumnId(id: string): BoardColumnId | null {
	if (id === "backlog" || id === "in_progress" || id === "review" || id === "trash") {
		return id;
	}
	return null;
}

function createBrowserUuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return Math.random().toString(36).slice(2, 12);
}

function normalizeTaskImages(rawImages: unknown): TaskImage[] | undefined {
	if (!Array.isArray(rawImages)) {
		return undefined;
	}
	const images: TaskImage[] = [];
	for (const rawImage of rawImages) {
		if (!rawImage || typeof rawImage !== "object") {
			continue;
		}
		const image = rawImage as { id?: unknown; data?: unknown; mimeType?: unknown; name?: unknown };
		if (typeof image.id !== "string" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
			continue;
		}
		images.push({
			id: image.id,
			data: image.data,
			mimeType: image.mimeType,
			...(typeof image.name === "string" ? { name: image.name } : {}),
		});
	}
	return images.length > 0 ? images : undefined;
}

function normalizeTaskOrigin(rawOrigin: unknown): RuntimeTaskOrigin | undefined {
	if (!rawOrigin || typeof rawOrigin !== "object") {
		return undefined;
	}
	const origin = rawOrigin as { kind?: unknown; threadId?: unknown };
	if (
		origin.kind !== "amp_architect" ||
		typeof origin.threadId !== "string" ||
		!/^T-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(origin.threadId)
	) {
		return undefined;
	}
	return {
		kind: "amp_architect",
		threadId: origin.threadId,
	};
}

function normalizeTaskAcceptanceEvidence(
	rawEvidence: unknown,
	taskId: string,
	generation: number,
): RuntimeTaskAcceptanceEvidence | undefined {
	if (!rawEvidence || typeof rawEvidence !== "object") {
		return undefined;
	}
	const evidence = rawEvidence as {
		kind?: unknown;
		taskId?: unknown;
		generation?: unknown;
		executionAttemptId?: unknown;
		acceptedRevision?: unknown;
		verifiedAt?: unknown;
	};
	if (evidence.kind === "verified_no_change_report") {
		const parsed = runtimeTaskAcceptanceEvidenceSchema.safeParse(rawEvidence);
		if (
			parsed.success &&
			parsed.data.kind === "verified_no_change_report" &&
			parsed.data.taskId === taskId &&
			parsed.data.generation === generation
		) {
			return parsed.data;
		}
		return undefined;
	}
	if (!evidence.acceptedRevision || typeof evidence.acceptedRevision !== "object") {
		return undefined;
	}
	const acceptedRevision = evidence.acceptedRevision as { sha?: unknown; remoteRef?: unknown };
	if (
		evidence.kind !== "verified_remote_revision" ||
		(evidence.taskId !== undefined && evidence.taskId !== taskId) ||
		(evidence.generation !== undefined && evidence.generation !== generation) ||
		(evidence.executionAttemptId !== undefined &&
			(typeof evidence.executionAttemptId !== "string" || !evidence.executionAttemptId.trim())) ||
		typeof acceptedRevision.sha !== "string" ||
		!/^[0-9a-f]{40,64}$/u.test(acceptedRevision.sha) ||
		typeof acceptedRevision.remoteRef !== "string" ||
		!/^refs\/heads\/kanban\/[A-Za-z0-9._/-]+$/u.test(acceptedRevision.remoteRef) ||
		typeof evidence.verifiedAt !== "number" ||
		!Number.isSafeInteger(evidence.verifiedAt) ||
		evidence.verifiedAt < 0
	) {
		return undefined;
	}
	return {
		kind: evidence.kind,
		taskId,
		generation,
		...(typeof evidence.executionAttemptId === "string" ? { executionAttemptId: evidence.executionAttemptId } : {}),
		acceptedRevision: {
			sha: acceptedRevision.sha,
			remoteRef: acceptedRevision.remoteRef,
		},
		verifiedAt: evidence.verifiedAt,
	};
}

function normalizeCard(rawCard: unknown): BoardCard | null {
	if (!rawCard || typeof rawCard !== "object") {
		return null;
	}

	const card = rawCard as {
		id?: unknown;
		title?: unknown;
		prompt?: unknown;
		startInPlanMode?: unknown;
		images?: unknown;
		baseRef?: unknown;
		agentId?: unknown;
		removedAgentId?: unknown;
		generation?: unknown;
		origin?: unknown;
		execution?: unknown;
		planning?: unknown;
		deliverableKind?: unknown;
		submission?: unknown;
		acceptanceEvidence?: unknown;
		createdAt?: unknown;
		updatedAt?: unknown;
	};
	const prompt = typeof card.prompt === "string" ? card.prompt.trim() : "";
	if (!prompt) {
		return null;
	}
	const baseRef = typeof card.baseRef === "string" ? card.baseRef.trim() : "";
	if (!baseRef) {
		return null;
	}
	const title = (typeof card.title === "string" ? card.title.trim() : "") || prompt;
	if (!title) {
		return null;
	}
	const now = Date.now();
	const id = typeof card.id === "string" && card.id ? card.id : createShortTaskId(createBrowserUuid);
	const origin = normalizeTaskOrigin(card.origin);
	const generation =
		typeof card.generation === "number" && Number.isSafeInteger(card.generation) && card.generation > 0
			? card.generation
			: 1;
	const execution =
		card.execution &&
		typeof card.execution === "object" &&
		typeof (card.execution as { attemptId?: unknown }).attemptId === "string" &&
		(card.execution as { attemptId: string }).attemptId.length > 0 &&
		(card.execution as { generation?: unknown }).generation === generation &&
		typeof (card.execution as { queuedAt?: unknown }).queuedAt === "number" &&
		Number.isFinite((card.execution as { queuedAt: number }).queuedAt)
			? {
					attemptId: (card.execution as { attemptId: string }).attemptId,
					generation: (card.execution as { generation: number }).generation,
					queuedAt: (card.execution as { queuedAt: number }).queuedAt,
				}
			: undefined;
	const planning =
		card.planning &&
		typeof card.planning === "object" &&
		typeof (card.planning as { trackId?: unknown }).trackId === "string" &&
		typeof (card.planning as { milestoneId?: unknown }).milestoneId === "string" &&
		((card.planning as { weight?: unknown }).weight === undefined ||
			(typeof (card.planning as { weight?: unknown }).weight === "number" &&
				(card.planning as { weight: number }).weight > 0))
			? {
					trackId: (card.planning as { trackId: string }).trackId,
					milestoneId: (card.planning as { milestoneId: string }).milestoneId,
					...((card.planning as { weight?: number }).weight !== undefined
						? { weight: (card.planning as { weight: number }).weight }
						: {}),
				}
			: undefined;
	const parsedDeliverableKind = runtimeTaskDeliverableKindSchema.safeParse(card.deliverableKind);
	const deliverableKind = parsedDeliverableKind.success ? parsedDeliverableKind.data : undefined;
	const parsedSubmission = runtimeTaskReviewSubmissionSchema.safeParse(card.submission);
	const submission =
		parsedSubmission.success &&
		parsedSubmission.data.taskId === id &&
		parsedSubmission.data.workspace.taskId === id &&
		parsedSubmission.data.generation === generation &&
		parsedSubmission.data.deliverableKind === deliverableKind
			? parsedSubmission.data
			: undefined;
	let acceptanceEvidence = normalizeTaskAcceptanceEvidence(card.acceptanceEvidence, id, generation);
	if (
		acceptanceEvidence?.kind === "verified_no_change_report" &&
		(!submission ||
			acceptanceEvidence.reportDigest !== submission.reportDigest ||
			JSON.stringify(acceptanceEvidence.receipt) !== JSON.stringify(submission.receipt))
	) {
		acceptanceEvidence = undefined;
	}

	return {
		id,
		title,
		prompt,
		startInPlanMode: typeof card.startInPlanMode === "boolean" ? card.startInPlanMode : false,
		images: normalizeTaskImages(card.images),
		baseRef,
		...(typeof card.agentId === "string" && card.agentId !== "cline"
			? { agentId: card.agentId as RuntimeAgentId }
			: {}),
		...(card.agentId === "cline" || card.removedAgentId === "cline" ? { removedAgentId: "cline" as const } : {}),
		generation,
		...(origin ? { origin } : {}),
		...(execution ? { execution } : {}),
		...(planning ? { planning } : {}),
		...(deliverableKind ? { deliverableKind } : {}),
		...(submission ? { submission } : {}),
		...(acceptanceEvidence ? { acceptanceEvidence } : {}),
		createdAt: typeof card.createdAt === "number" ? card.createdAt : now,
		updatedAt: typeof card.updatedAt === "number" ? card.updatedAt : now,
	};
}

function createDependencyId(): string {
	return createBrowserUuid().replaceAll("-", "").slice(0, 8);
}

function collectTaskIds(columns: BoardColumn[]): Set<string> {
	const taskIds = new Set<string>();
	for (const column of columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function normalizeDependency(rawDependency: unknown, taskIds: Set<string>): BoardDependency | null {
	if (!rawDependency || typeof rawDependency !== "object") {
		return null;
	}

	const dependency = rawDependency as {
		id?: unknown;
		fromTaskId?: unknown;
		toTaskId?: unknown;
		createdAt?: unknown;
	};
	const fromTaskId = typeof dependency.fromTaskId === "string" ? dependency.fromTaskId.trim() : "";
	const toTaskId = typeof dependency.toTaskId === "string" ? dependency.toTaskId.trim() : "";
	if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) {
		return null;
	}
	if (!taskIds.has(fromTaskId) || !taskIds.has(toTaskId)) {
		return null;
	}

	return {
		id: typeof dependency.id === "string" && dependency.id ? dependency.id : createDependencyId(),
		fromTaskId,
		toTaskId,
		createdAt: typeof dependency.createdAt === "number" ? dependency.createdAt : Date.now(),
	};
}
export function normalizeBoardData(rawBoard: unknown): BoardData | null {
	if (!rawBoard || typeof rawBoard !== "object") {
		return null;
	}

	const candidateColumns = (rawBoard as { columns?: unknown }).columns;
	const candidateDependencies = (rawBoard as { dependencies?: unknown }).dependencies;
	const candidateTracks = (rawBoard as { tracks?: unknown }).tracks;
	const candidateMilestones = (rawBoard as { milestones?: unknown }).milestones;
	if (!Array.isArray(candidateColumns)) {
		return null;
	}

	const initial = createInitialBoardData();
	const normalizedColumns = initial.columns.map((column) => ({ ...column, cards: [] as BoardCard[] }));
	const columnById = new Map(normalizedColumns.map((column) => [column.id, column]));

	for (const rawColumn of candidateColumns) {
		if (!rawColumn || typeof rawColumn !== "object") {
			continue;
		}
		const column = rawColumn as { id?: unknown; cards?: unknown };
		if (typeof column.id !== "string") {
			continue;
		}
		const normalizedId = normalizeColumnId(column.id);
		if (!normalizedId) {
			continue;
		}
		const normalizedColumn = columnById.get(normalizedId);
		if (!normalizedColumn || !Array.isArray(column.cards)) {
			continue;
		}
		for (const rawCard of column.cards) {
			const card = normalizeCard(rawCard);
			if (card) {
				normalizedColumn.cards.push(card);
			}
		}
	}

	const taskIds = collectTaskIds(normalizedColumns);
	const normalizedDependencies: BoardDependency[] = [];
	if (Array.isArray(candidateDependencies)) {
		for (const rawDependency of candidateDependencies) {
			const dependency = normalizeDependency(rawDependency, taskIds);
			if (!dependency) {
				continue;
			}
			normalizedDependencies.push(dependency);
		}
	}

	return runtimeTaskState.updateTaskDependencies({
		columns: normalizedColumns,
		dependencies: normalizedDependencies,
		...(Array.isArray(candidateTracks) ? { tracks: candidateTracks as BoardData["tracks"] } : {}),
		...(Array.isArray(candidateMilestones) ? { milestones: candidateMilestones as BoardData["milestones"] } : {}),
	});
}

export function addTaskToColumn(board: BoardData, columnId: BoardColumnId, draft: TaskDraft): BoardData {
	const prompt = draft.prompt.trim();
	if (!prompt) {
		return board;
	}
	return addTaskToColumnWithResult(board, columnId, draft).board;
}

export function addTaskToColumnWithResult(
	board: BoardData,
	columnId: BoardColumnId,
	draft: TaskDraft,
): { board: BoardData; task: BoardCard } {
	const prompt = draft.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt is required.");
	}
	const result = runtimeTaskState.addTaskToColumn(
		board,
		columnId,
		{
			title: draft.title,
			prompt,
			startInPlanMode: draft.startInPlanMode,
			images: draft.images,
			agentId: draft.agentId,
			baseRef: draft.baseRef,
		},
		createBrowserUuid,
	);
	return {
		board: result.board,
		task: result.task,
	};
}

export interface AddTaskDependencyResult {
	board: BoardData;
	added: boolean;
	reason?: NonNullable<runtimeTaskState.RuntimeAddTaskDependencyResult["reason"]>;
	dependency?: BoardDependency;
}

export function addTaskDependency(board: BoardData, fromTaskId: string, toTaskId: string): AddTaskDependencyResult {
	return runtimeTaskState.addTaskDependency(board, fromTaskId, toTaskId);
}

export function canCreateTaskDependency(board: BoardData, fromTaskId: string, toTaskId: string): boolean {
	return runtimeTaskState.canAddTaskDependency(board, fromTaskId, toTaskId);
}

export function removeTaskDependency(board: BoardData, dependencyId: string): { board: BoardData; removed: boolean } {
	return runtimeTaskState.removeTaskDependency(board, dependencyId);
}

export function discardTask(board: BoardData, taskId: string): { board: BoardData; moved: boolean } {
	return runtimeTaskState.discardTask(board, taskId);
}

export function applyDragResult(
	board: BoardData,
	result: DropResult,
	options?: { programmaticCardMoveInFlight?: ProgrammaticCardMoveInFlight | null },
): { board: BoardData; moveEvent?: TaskMoveEvent } {
	const { source, destination, type } = result;

	if (!destination) {
		return { board };
	}

	if (source.droppableId === destination.droppableId && source.index === destination.index) {
		return { board };
	}

	if (type === "COLUMN") {
		return { board };
	}

	const sourceColumnIndex = board.columns.findIndex((column) => column.id === source.droppableId);
	const destinationColumnIndex = board.columns.findIndex((column) => column.id === destination.droppableId);
	const sourceColumn = board.columns[sourceColumnIndex];
	const destinationColumn = board.columns[destinationColumnIndex];

	if (!sourceColumn || !destinationColumn) {
		return { board };
	}

	if (sourceColumn.id === destinationColumn.id) {
		const movedCards = reorder(sourceColumn.cards, source.index, destination.index);
		const columns = Array.from(board.columns);
		columns[sourceColumnIndex] = {
			...sourceColumn,
			cards: movedCards,
		};
		return { board: withUpdatedColumns(board, columns) };
	}

	const isAllowedCrossColumnMove = isAllowedCrossColumnCardMove(sourceColumn.id, destinationColumn.id, {
		taskId: result.draggableId,
		programmaticCardMoveInFlight: options?.programmaticCardMoveInFlight,
	});
	if (!isAllowedCrossColumnMove) {
		return { board };
	}
	if (
		sourceColumn.id === "backlog" &&
		destinationColumn.id === "in_progress" &&
		board.dependencies.some((dependency) => dependency.fromTaskId === result.draggableId)
	) {
		return { board };
	}

	const sourceCards = Array.from(sourceColumn.cards);
	const [movedCard] = sourceCards.splice(source.index, 1);
	if (!movedCard) {
		return { board };
	}

	const destinationCards = Array.from(destinationColumn.cards);
	const destinationInsertIndex = options?.programmaticCardMoveInFlight?.insertAtTop ? 0 : destination.index;
	const destinationTask = updateTaskTimestamp(movedCard);
	if (destinationColumn.id === "trash") {
		delete destinationTask.execution;
	}
	if (sourceColumn.id === "trash" && destinationColumn.id === "review") {
		delete destinationTask.acceptanceEvidence;
		delete destinationTask.submission;
	}
	destinationCards.splice(destinationInsertIndex, 0, destinationTask);

	const columns = Array.from(board.columns);
	columns[sourceColumnIndex] = {
		...sourceColumn,
		cards: sourceCards,
	};
	columns[destinationColumnIndex] = {
		...destinationColumn,
		cards: destinationCards,
	};

	return {
		board: runtimeTaskState.updateTaskDependencies(withUpdatedColumns(board, columns)),
		moveEvent: {
			taskId: movedCard.id,
			fromColumnId: sourceColumn.id,
			toColumnId: destinationColumn.id,
		},
	};
}
export function moveTaskToColumn(
	board: BoardData,
	taskId: string,
	targetColumnId: BoardColumnId,
	options?: { insertAtTop?: boolean },
): { board: BoardData; moved: boolean } {
	const moved = runtimeTaskState.moveTaskToColumn(board, taskId, targetColumnId);
	if (!moved.moved || !options?.insertAtTop) {
		return {
			board: moved.moved ? moved.board : board,
			moved: moved.moved,
		};
	}
	const targetColumnIndex = moved.board.columns.findIndex((column) => column.id === targetColumnId);
	const targetColumn = moved.board.columns[targetColumnIndex];
	if (!targetColumn) {
		return {
			board: moved.board,
			moved: moved.moved,
		};
	}
	const movedTaskIndex = targetColumn.cards.findIndex((card) => card.id === taskId);
	if (movedTaskIndex <= 0) {
		return {
			board: moved.board,
			moved: moved.moved,
		};
	}
	const targetCards = Array.from(targetColumn.cards);
	const [movedTask] = targetCards.splice(movedTaskIndex, 1);
	if (!movedTask) {
		return {
			board: moved.board,
			moved: moved.moved,
		};
	}
	targetCards.unshift(movedTask);
	const columns = Array.from(moved.board.columns);
	columns[targetColumnIndex] = {
		...targetColumn,
		cards: targetCards,
	};
	return {
		board: withUpdatedColumns(moved.board, columns),
		moved: moved.moved,
	};
}

export function updateTask(board: BoardData, taskId: string, draft: TaskDraft): { board: BoardData; updated: boolean } {
	const prompt = draft.prompt.trim();
	if (!prompt) {
		return { board, updated: false };
	}
	const title = typeof draft.title === "string" ? draft.title.trim() : "";
	const baseRef = draft.baseRef.trim();
	if (!baseRef) {
		return { board, updated: false };
	}

	let updated = false;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== taskId) {
				return card;
			}
			const images =
				draft.images === undefined
					? card.images
					: draft.images.length > 0
						? draft.images.map((image) => ({ ...image }))
						: undefined;
			const startInPlanMode = Boolean(draft.startInPlanMode);
			const generation = runtimeTaskState.resolveUpdatedTaskGeneration(card, {
				prompt,
				startInPlanMode,
				images,
				agentId: draft.agentId,
				removedAgentId: draft.agentId === undefined ? card.removedAgentId : undefined,
				deliverableKind: card.deliverableKind,
				baseRef,
			});
			columnUpdated = true;
			updated = true;
			return {
				...card,
				title: title || card.title,
				prompt,
				startInPlanMode,
				images,
				agentId: draft.agentId,
				removedAgentId: draft.agentId === undefined ? card.removedAgentId : undefined,
				generation,
				execution: generation === (card.generation ?? 1) ? card.execution : undefined,
				submission: generation === (card.generation ?? 1) ? card.submission : undefined,
				acceptanceEvidence: generation === (card.generation ?? 1) ? card.acceptanceEvidence : undefined,
				baseRef,
				updatedAt: Date.now(),
			};
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updated) {
		return { board, updated: false };
	}
	return { board: withUpdatedColumns(board, columns), updated: true };
}

export function updateTaskTitle(
	board: BoardData,
	taskId: string,
	title: string,
): { board: BoardData; updated: boolean } {
	const selection = findCardSelection(board, taskId);
	if (!selection) {
		return { board, updated: false };
	}
	return updateTask(board, taskId, {
		title,
		prompt: selection.card.prompt,
		startInPlanMode: selection.card.startInPlanMode,
		images: selection.card.images,
		agentId: selection.card.agentId,
		baseRef: selection.card.baseRef,
	});
}

export function findCardSelection(board: BoardData, taskId: string): CardSelection | null {
	for (const column of board.columns) {
		const card = column.cards.find((task) => task.id === taskId);
		if (card) {
			return {
				card,
				column,
				allColumns: board.columns,
			};
		}
	}
	return null;
}

export function getTaskColumnId(board: BoardData, taskId: string): BoardColumnId | null {
	return runtimeTaskState.getTaskColumnId(board, taskId);
}
