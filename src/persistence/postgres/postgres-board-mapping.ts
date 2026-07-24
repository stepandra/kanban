import {
	type RuntimeBoardCard,
	type RuntimeBoardColumn,
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	type RuntimeBoardDependency,
	runtimeBoardCardSchema,
	runtimeBoardDataSchema,
} from "../../core/api-contract";

const REQUIRED_COLUMN_IDS: readonly RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "trash"];

export interface PostgresColumnRecord {
	workspaceId: string;
	columnId: RuntimeBoardColumnId;
	title: string;
	position: number;
}

export interface PostgresCardRecord {
	workspaceId: string;
	cardId: string;
	columnId: RuntimeBoardColumnId;
	position: number;
	card: RuntimeBoardCard;
}

export interface PostgresDependencyRecord {
	workspaceId: string;
	dependencyId: string;
	fromTaskId: string;
	toTaskId: string;
	position: number;
	createdAt: number;
}

export interface PostgresBoardRecords {
	columns: PostgresColumnRecord[];
	cards: PostgresCardRecord[];
	dependencies: PostgresDependencyRecord[];
}

function requireNonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${field} cannot be empty.`);
	}
	return normalized;
}

function requireSafeNonNegativeInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative safe integer.`);
	}
	return value;
}

function assertUnique(value: string, values: Set<string>, label: string): void {
	if (values.has(value)) {
		throw new Error(`Duplicate ${label}: ${value}`);
	}
	values.add(value);
}

function assertDependencyDag(cards: Set<string>, dependencies: RuntimeBoardDependency[]): void {
	const outgoing = new Map<string, string[]>();
	for (const dependency of dependencies) {
		if (!cards.has(dependency.fromTaskId) || !cards.has(dependency.toTaskId)) {
			throw new Error(`Dependency ${dependency.id} must reference existing Kanban cards.`);
		}
		const next = outgoing.get(dependency.fromTaskId) ?? [];
		next.push(dependency.toTaskId);
		outgoing.set(dependency.fromTaskId, next);
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (taskId: string): void => {
		if (visiting.has(taskId)) {
			throw new Error("Kanban dependencies must form an acyclic graph.");
		}
		if (visited.has(taskId)) {
			return;
		}
		visiting.add(taskId);
		for (const linkedTaskId of outgoing.get(taskId) ?? []) {
			visit(linkedTaskId);
		}
		visiting.delete(taskId);
		visited.add(taskId);
	};
	for (const cardId of cards) {
		visit(cardId);
	}
}

export function mapBoardToPostgresRecords(workspaceId: string, input: RuntimeBoardData): PostgresBoardRecords {
	const normalizedWorkspaceId = requireNonEmpty(workspaceId, "workspaceId");
	const board = runtimeBoardDataSchema.parse(input);
	if (board.columns.length !== REQUIRED_COLUMN_IDS.length) {
		throw new Error(`Kanban boards must contain exactly ${REQUIRED_COLUMN_IDS.length} authority columns.`);
	}

	const columnIds = new Set<string>();
	const cardIds = new Set<string>();
	const dependencyIds = new Set<string>();
	const dependencyPairs = new Set<string>();
	const columns: PostgresColumnRecord[] = [];
	const cards: PostgresCardRecord[] = [];

	board.columns.forEach((column, columnPosition) => {
		assertUnique(column.id, columnIds, "column ID");
		columns.push({
			workspaceId: normalizedWorkspaceId,
			columnId: column.id,
			title: column.title,
			position: columnPosition,
		});
		column.cards.forEach((card, cardPosition) => {
			requireNonEmpty(card.id, "card.id");
			assertUnique(card.id, cardIds, "card ID");
			cards.push({
				workspaceId: normalizedWorkspaceId,
				cardId: card.id,
				columnId: column.id,
				position: cardPosition,
				card,
			});
		});
	});

	for (const requiredColumnId of REQUIRED_COLUMN_IDS) {
		if (!columnIds.has(requiredColumnId)) {
			throw new Error(`Kanban board is missing required column "${requiredColumnId}".`);
		}
	}

	const dependencies = board.dependencies.map((dependency, position) => {
		requireNonEmpty(dependency.id, "dependency.id");
		requireNonEmpty(dependency.fromTaskId, "dependency.fromTaskId");
		requireNonEmpty(dependency.toTaskId, "dependency.toTaskId");
		if (dependency.fromTaskId === dependency.toTaskId) {
			throw new Error(`Dependency ${dependency.id} cannot link a card to itself.`);
		}
		assertUnique(dependency.id, dependencyIds, "dependency ID");
		assertUnique(`${dependency.fromTaskId}\u0000${dependency.toTaskId}`, dependencyPairs, "dependency edge");
		return {
			workspaceId: normalizedWorkspaceId,
			dependencyId: dependency.id,
			fromTaskId: dependency.fromTaskId,
			toTaskId: dependency.toTaskId,
			position,
			createdAt: requireSafeNonNegativeInteger(dependency.createdAt, `dependency ${dependency.id} createdAt`),
		};
	});
	assertDependencyDag(cardIds, board.dependencies);

	return { columns, cards, dependencies };
}

export function mapPostgresRecordsToBoard(records: PostgresBoardRecords): RuntimeBoardData {
	const cardsByColumn = new Map<RuntimeBoardColumnId, PostgresCardRecord[]>();
	for (const cardRecord of records.cards) {
		const cards = cardsByColumn.get(cardRecord.columnId) ?? [];
		cards.push(cardRecord);
		cardsByColumn.set(cardRecord.columnId, cards);
	}

	const columns: RuntimeBoardColumn[] = [...records.columns]
		.sort((left, right) => left.position - right.position)
		.map((column) => ({
			id: column.columnId,
			title: column.title,
			cards: (cardsByColumn.get(column.columnId) ?? [])
				.sort((left, right) => left.position - right.position)
				.map((card) => runtimeBoardCardSchema.parse(card.card)),
		}));
	const dependencies: RuntimeBoardDependency[] = [...records.dependencies]
		.sort((left, right) => left.position - right.position)
		.map((dependency) => ({
			id: dependency.dependencyId,
			fromTaskId: dependency.fromTaskId,
			toTaskId: dependency.toTaskId,
			createdAt: dependency.createdAt,
		}));

	const board = runtimeBoardDataSchema.parse({ columns, dependencies });
	mapBoardToPostgresRecords(records.columns[0]?.workspaceId ?? "loaded-workspace", board);
	return board;
}
