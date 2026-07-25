import type { Pool, PoolClient, QueryResultRow } from "pg";

import { runtimeBoardCardSchema } from "../../core/api-contract";
import type {
	KanbanBoardRepository,
	KanbanBoardWorkspace,
	KanbanBoardWorkspaceSave,
	KanbanImportReceipt,
	KanbanLegacyWorkspaceImport,
	KanbanLegacyWorkspaceImportResult,
} from "../board-repository";
import {
	mapBoardToPostgresRecords,
	mapPostgresRecordsToBoard,
	type PostgresBoardRecords,
	type PostgresCardRecord,
	type PostgresColumnRecord,
	type PostgresDependencyRecord,
} from "./postgres-board-mapping";
import { getKanbanPostgresSchemaSearchPath } from "./postgres-migrations";

interface WorkspaceRow extends QueryResultRow {
	workspace_id: string;
	repo_path: string;
	revision: string | number;
	updated_at_ms: string | number;
}

interface ColumnRow extends QueryResultRow {
	workspace_id: string;
	column_id: "backlog" | "in_progress" | "review" | "trash";
	title: string;
	position: number;
}

interface CardRow extends QueryResultRow {
	workspace_id: string;
	card_id: string;
	column_id: "backlog" | "in_progress" | "review" | "trash";
	position: number;
	card_json: unknown;
}

interface DependencyRow extends QueryResultRow {
	workspace_id: string;
	dependency_id: string;
	from_task_id: string;
	to_task_id: string;
	position: number;
	created_at_ms: string | number;
}

interface ImportReceiptRow extends QueryResultRow {
	workspace_id: string;
	source_kind: "indexed-json-v1";
	source_checksum: string;
	source_revision: string | number;
	imported_at_ms: string | number;
	card_count: number;
	dependency_count: number;
}

interface TargetCountRow extends QueryResultRow {
	column_count: string | number;
	card_count: string | number;
	dependency_count: string | number;
}

function requireSafeNonNegativeInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative safe integer.`);
	}
	return value;
}

function parseSafeNonNegativeInteger(value: string | number, field: string): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return requireSafeNonNegativeInteger(parsed, field);
}

function requireNonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${field} cannot be empty.`);
	}
	return normalized;
}

function mapImportReceipt(row: ImportReceiptRow): KanbanImportReceipt {
	return {
		workspaceId: row.workspace_id,
		source: {
			kind: row.source_kind,
			checksum: row.source_checksum,
			revision: parseSafeNonNegativeInteger(row.source_revision, "source_revision"),
		},
		importedAt: parseSafeNonNegativeInteger(row.imported_at_ms, "imported_at_ms"),
		cardCount: parseSafeNonNegativeInteger(row.card_count, "card_count"),
		dependencyCount: parseSafeNonNegativeInteger(row.dependency_count, "dependency_count"),
	};
}

export class PostgresWorkspaceRevisionConflictError extends Error {
	readonly currentRevision: number | null;

	constructor(expectedRevision: number, currentRevision: number | null) {
		super(
			currentRevision === null
				? `PostgreSQL workspace does not exist for expected revision ${expectedRevision}.`
				: `PostgreSQL workspace revision mismatch: expected ${expectedRevision}, current ${currentRevision}.`,
		);
		this.name = "PostgresWorkspaceRevisionConflictError";
		this.currentRevision = currentRevision;
	}
}

export class PostgresLegacyImportConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PostgresLegacyImportConflictError";
	}
}

export class PostgresKanbanBoardRepository implements KanbanBoardRepository {
	readonly #pool: Pool;
	readonly #searchPath: string;

	constructor(pool: Pool, options: { schema?: string } = {}) {
		this.#pool = pool;
		this.#searchPath = getKanbanPostgresSchemaSearchPath(options.schema ?? "public");
	}

	async #withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
		const client = await this.#pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(`SET LOCAL search_path TO ${this.#searchPath}`);
			const value = await run(client);
			await client.query("COMMIT");
			return value;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async #loadBoardRecords(client: PoolClient, workspaceId: string): Promise<PostgresBoardRecords> {
		const columnRows = await client.query<ColumnRow>(
			`SELECT workspace_id, column_id, title, position
			 FROM kanban_columns
			 WHERE workspace_id = $1
			 ORDER BY position`,
			[workspaceId],
		);
		const cardRows = await client.query<CardRow>(
			`SELECT workspace_id, card_id, column_id, position, card_json
			 FROM kanban_cards
			 WHERE workspace_id = $1
			 ORDER BY column_id, position`,
			[workspaceId],
		);
		const dependencyRows = await client.query<DependencyRow>(
			`SELECT workspace_id, dependency_id, from_task_id, to_task_id, position, created_at_ms
			 FROM kanban_dependencies
			 WHERE workspace_id = $1
			 ORDER BY position`,
			[workspaceId],
		);

		const columns: PostgresColumnRecord[] = columnRows.rows.map((row) => ({
			workspaceId: row.workspace_id,
			columnId: row.column_id,
			title: row.title,
			position: row.position,
		}));
		const cards: PostgresCardRecord[] = cardRows.rows.map((row) => ({
			workspaceId: row.workspace_id,
			cardId: row.card_id,
			columnId: row.column_id,
			position: row.position,
			card: runtimeBoardCardSchema.parse(row.card_json),
		}));
		const dependencies: PostgresDependencyRecord[] = dependencyRows.rows.map((row) => ({
			workspaceId: row.workspace_id,
			dependencyId: row.dependency_id,
			fromTaskId: row.from_task_id,
			toTaskId: row.to_task_id,
			position: row.position,
			createdAt: parseSafeNonNegativeInteger(row.created_at_ms, "created_at_ms"),
		}));
		return { columns, cards, dependencies };
	}

	async #insertBoard(client: PoolClient, records: PostgresBoardRecords): Promise<void> {
		for (const column of records.columns) {
			await client.query(
				`INSERT INTO kanban_columns (workspace_id, column_id, title, position)
				 VALUES ($1, $2, $3, $4)`,
				[column.workspaceId, column.columnId, column.title, column.position],
			);
		}
		for (const card of records.cards) {
			await client.query(
				`INSERT INTO kanban_cards (workspace_id, card_id, column_id, position, card_json)
				 VALUES ($1, $2, $3, $4, $5::jsonb)`,
				[card.workspaceId, card.cardId, card.columnId, card.position, JSON.stringify(card.card)],
			);
		}
		for (const dependency of records.dependencies) {
			await client.query(
				`INSERT INTO kanban_dependencies (
					workspace_id,
					dependency_id,
					from_task_id,
					to_task_id,
					position,
					created_at_ms
				) VALUES ($1, $2, $3, $4, $5, $6)`,
				[
					dependency.workspaceId,
					dependency.dependencyId,
					dependency.fromTaskId,
					dependency.toTaskId,
					dependency.position,
					dependency.createdAt,
				],
			);
		}
	}

	async loadWorkspace(workspaceId: string): Promise<KanbanBoardWorkspace | null> {
		const normalizedWorkspaceId = requireNonEmpty(workspaceId, "workspaceId");
		return await this.#withTransaction(async (client) => {
			const workspaceResult = await client.query<WorkspaceRow>(
				`SELECT workspace_id, repo_path, revision, updated_at_ms
				 FROM kanban_workspaces
				 WHERE workspace_id = $1
				 FOR SHARE`,
				[normalizedWorkspaceId],
			);
			const workspace = workspaceResult.rows[0];
			if (!workspace) {
				return null;
			}
			const records = await this.#loadBoardRecords(client, normalizedWorkspaceId);
			return {
				workspaceId: workspace.workspace_id,
				repoPath: workspace.repo_path,
				revision: parseSafeNonNegativeInteger(workspace.revision, "revision"),
				updatedAt: parseSafeNonNegativeInteger(workspace.updated_at_ms, "updated_at_ms"),
				board: mapPostgresRecordsToBoard(records),
			};
		});
	}

	async saveWorkspace(input: KanbanBoardWorkspaceSave): Promise<KanbanBoardWorkspace> {
		const workspaceId = requireNonEmpty(input.workspaceId, "workspaceId");
		const expectedRevision = requireSafeNonNegativeInteger(input.expectedRevision, "expectedRevision");
		const updatedAt = requireSafeNonNegativeInteger(input.updatedAt, "updatedAt");
		const boardRecords = mapBoardToPostgresRecords(workspaceId, input.board);

		return await this.#withTransaction(async (client) => {
			const updated = await client.query<WorkspaceRow>(
				`UPDATE kanban_workspaces
				 SET revision = revision + 1, updated_at_ms = $3
				 WHERE workspace_id = $1 AND revision = $2
				 RETURNING workspace_id, repo_path, revision, updated_at_ms`,
				[workspaceId, expectedRevision, updatedAt],
			);
			const workspace = updated.rows[0];
			if (!workspace) {
				const current = await client.query<Pick<WorkspaceRow, "revision">>(
					"SELECT revision FROM kanban_workspaces WHERE workspace_id = $1",
					[workspaceId],
				);
				throw new PostgresWorkspaceRevisionConflictError(
					expectedRevision,
					current.rows[0] ? parseSafeNonNegativeInteger(current.rows[0].revision, "revision") : null,
				);
			}

			await client.query("DELETE FROM kanban_columns WHERE workspace_id = $1", [workspaceId]);
			await this.#insertBoard(client, boardRecords);
			return {
				workspaceId,
				repoPath: workspace.repo_path,
				revision: parseSafeNonNegativeInteger(workspace.revision, "revision"),
				updatedAt,
				board: input.board,
			};
		});
	}

	async importLegacyWorkspace(input: KanbanLegacyWorkspaceImport): Promise<KanbanLegacyWorkspaceImportResult> {
		const workspaceId = requireNonEmpty(input.workspace.workspaceId, "workspace.workspaceId");
		const repoPath = requireNonEmpty(input.workspace.repoPath, "workspace.repoPath");
		const sourceChecksum = input.source.checksum.trim();
		if (!/^[0-9a-f]{64}$/.test(sourceChecksum)) {
			throw new Error("source.checksum must be a lowercase SHA-256 checksum.");
		}
		if (input.source.kind !== "indexed-json-v1") {
			throw new Error(`Unsupported legacy import source: ${input.source.kind}`);
		}
		const sourceRevision = requireSafeNonNegativeInteger(input.source.revision, "source.revision");
		const workspaceRevision = requireSafeNonNegativeInteger(input.workspace.revision, "workspace.revision");
		if (sourceRevision !== workspaceRevision) {
			throw new Error("Legacy import source revision must match the imported workspace revision.");
		}
		const updatedAt = requireSafeNonNegativeInteger(input.workspace.updatedAt, "workspace.updatedAt");
		const boardRecords = mapBoardToPostgresRecords(workspaceId, input.workspace.board);

		return await this.#withTransaction(async (client) => {
			await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
				`kanban-workspace-import:${workspaceId}`,
			]);
			const priorReceiptResult = await client.query<ImportReceiptRow>(
				`SELECT
						workspace_id,
						source_kind,
						source_checksum,
						source_revision,
						imported_at_ms,
						card_count,
						dependency_count
					 FROM kanban_import_receipts
					 WHERE workspace_id = $1`,
				[workspaceId],
			);
			const priorReceiptRow = priorReceiptResult.rows[0];
			if (priorReceiptRow) {
				const priorReceipt = mapImportReceipt(priorReceiptRow);
				if (
					priorReceipt.source.kind === input.source.kind &&
					priorReceipt.source.checksum === sourceChecksum &&
					priorReceipt.source.revision === sourceRevision
				) {
					return { status: "already-imported", receipt: priorReceipt };
				}
				throw new PostgresLegacyImportConflictError(
					`Workspace ${workspaceId} has a conflicting immutable import receipt.`,
				);
			}

			const workspaceResult = await client.query<WorkspaceRow>(
				`SELECT workspace_id, repo_path, revision, updated_at_ms
					 FROM kanban_workspaces
					 WHERE workspace_id = $1
					 FOR UPDATE`,
				[workspaceId],
			);
			const existingWorkspace = workspaceResult.rows[0];
			if (existingWorkspace) {
				const counts = await client.query<TargetCountRow>(
					`SELECT
							(SELECT count(*) FROM kanban_columns WHERE workspace_id = $1) AS column_count,
							(SELECT count(*) FROM kanban_cards WHERE workspace_id = $1) AS card_count,
							(SELECT count(*) FROM kanban_dependencies WHERE workspace_id = $1) AS dependency_count`,
					[workspaceId],
				);
				const targetCounts = counts.rows[0];
				const targetIsNonEmpty =
					!targetCounts ||
					parseSafeNonNegativeInteger(targetCounts.column_count, "column_count") > 0 ||
					parseSafeNonNegativeInteger(targetCounts.card_count, "card_count") > 0 ||
					parseSafeNonNegativeInteger(targetCounts.dependency_count, "dependency_count") > 0;
				if (targetIsNonEmpty) {
					throw new PostgresLegacyImportConflictError(
						`Workspace ${workspaceId} already has PostgreSQL board authority data.`,
					);
				}
				if (existingWorkspace.repo_path !== repoPath) {
					throw new PostgresLegacyImportConflictError(
						`Workspace ${workspaceId} already belongs to a different repository path.`,
					);
				}
				await client.query(
					`UPDATE kanban_workspaces
						 SET revision = $2, updated_at_ms = $3
						 WHERE workspace_id = $1`,
					[workspaceId, workspaceRevision, updatedAt],
				);
			} else {
				await client.query(
					`INSERT INTO kanban_workspaces (workspace_id, repo_path, revision, updated_at_ms)
						 VALUES ($1, $2, $3, $4)`,
					[workspaceId, repoPath, workspaceRevision, updatedAt],
				);
			}

			await this.#insertBoard(client, boardRecords);
			const importedAt = Date.now();
			const receiptResult = await client.query<ImportReceiptRow>(
				`INSERT INTO kanban_import_receipts (
						workspace_id,
						source_kind,
						source_checksum,
						source_revision,
						imported_at_ms,
						card_count,
						dependency_count
					 ) VALUES ($1, $2, $3, $4, $5, $6, $7)
					 RETURNING
						workspace_id,
						source_kind,
						source_checksum,
						source_revision,
						imported_at_ms,
						card_count,
						dependency_count`,
				[
					workspaceId,
					input.source.kind,
					sourceChecksum,
					sourceRevision,
					importedAt,
					boardRecords.cards.length,
					boardRecords.dependencies.length,
				],
			);
			const receipt = receiptResult.rows[0];
			if (!receipt) {
				throw new Error(`PostgreSQL did not return an import receipt for workspace ${workspaceId}.`);
			}
			return { status: "imported", receipt: mapImportReceipt(receipt) };
		});
	}
}
