import { randomUUID } from "node:crypto";
import { type DatabaseError, Pool } from "pg";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import { createIndexedJsonImport } from "../../src/persistence/legacy-json-importer";
import {
	PostgresKanbanBoardRepository,
	PostgresLegacyImportConflictError,
	type PostgresWorkspaceRevisionConflictError,
} from "../../src/persistence/postgres/postgres-board-repository";
import { migrateKanbanPostgres } from "../../src/persistence/postgres/postgres-migrations";

const testDatabaseUrl = process.env.KANBAN_TEST_DATABASE_URL?.trim();
const describePostgres = testDatabaseUrl ? describe.sequential : describe.skip;

function createBoard(prompt = "Task A"): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-a",
						title: prompt,
						prompt,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 10,
						updatedAt: 20,
					},
				],
			},
			{
				id: "in_progress",
				title: "In Progress",
				cards: [
					{
						id: "task-b",
						title: "Task B",
						prompt: "Task B",
						startInPlanMode: true,
						baseRef: "main",
						createdAt: 30,
						updatedAt: 40,
					},
				],
			},
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [
			{
				id: "dependency-a-b",
				fromTaskId: "task-a",
				toTaskId: "task-b",
				createdAt: 50,
			},
		],
	};
}

function createImport(workspaceId: string, repoPath: string, prompt = "Task A") {
	return createIndexedJsonImport({
		workspaceId,
		repoPath,
		board: createBoard(prompt),
		revision: 3,
		updatedAt: 60,
	});
}

function quoteTestSchema(schema: string): string {
	if (!/^kanban_test_[a-f0-9]+$/.test(schema)) {
		throw new Error(`Unsafe test schema: ${schema}`);
	}
	return `"${schema}"`;
}

function expectDatabaseCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && (error as DatabaseError).code === code;
}

describePostgres("PostgresKanbanBoardRepository integration", () => {
	const schema = `kanban_test_${randomUUID().replaceAll("-", "")}`;
	const quotedSchema = quoteTestSchema(schema);
	let pool: Pool;
	let repository: PostgresKanbanBoardRepository;

	beforeAll(async () => {
		pool = new Pool({
			connectionString: testDatabaseUrl,
			application_name: "kanban-postgres-integration-test",
		});
		await pool.query(`CREATE SCHEMA ${quotedSchema}`);
		await migrateKanbanPostgres(pool, schema);
		await migrateKanbanPostgres(pool, schema);
		repository = new PostgresKanbanBoardRepository(pool, { schema });
	});

	afterAll(async () => {
		await pool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
		await pool.end();
	});

	it("fails closed when the configured schema does not exist", async () => {
		const missingSchema = `kanban_test_${randomUUID().replaceAll("-", "")}`;
		const publicTableBefore = await pool.query<{ relation: string | null }>(
			"SELECT to_regclass('public.kanban_workspaces')::text AS relation",
		);

		await expect(migrateKanbanPostgres(pool, missingSchema)).rejects.toThrow();

		const publicTableAfter = await pool.query<{ relation: string | null }>(
			"SELECT to_regclass('public.kanban_workspaces')::text AS relation",
		);
		expect(publicTableAfter.rows[0]?.relation).toBe(publicTableBefore.rows[0]?.relation);
	});

	it("round-trips imported authority state and enforces compare-and-swap revisions transactionally", async () => {
		const imported = await repository.importLegacyWorkspace(createImport("workspace-cas", "/tmp/workspace-cas"));
		expect(imported.status).toBe("imported");
		expect(imported.receipt).toMatchObject({
			workspaceId: "workspace-cas",
			source: { kind: "indexed-json-v1", revision: 3 },
			cardCount: 2,
			dependencyCount: 1,
		});

		const loaded = await repository.loadWorkspace("workspace-cas");
		expect(loaded).toMatchObject({
			workspaceId: "workspace-cas",
			repoPath: "/tmp/workspace-cas",
			revision: 3,
			updatedAt: 60,
			board: createBoard(),
		});

		const changedBoard = createBoard("Task A changed");
		const saved = await repository.saveWorkspace({
			workspaceId: "workspace-cas",
			expectedRevision: 3,
			board: changedBoard,
			updatedAt: 70,
		});
		expect(saved.revision).toBe(4);
		expect(saved.board).toEqual(changedBoard);

		await expect(
			repository.saveWorkspace({
				workspaceId: "workspace-cas",
				expectedRevision: 3,
				board: createBoard("Stale update"),
				updatedAt: 80,
			}),
		).rejects.toEqual(
			expect.objectContaining({
				name: "PostgresWorkspaceRevisionConflictError",
				currentRevision: 4,
			}) satisfies Partial<PostgresWorkspaceRevisionConflictError>,
		);
		expect(await repository.loadWorkspace("workspace-cas")).toMatchObject({
			revision: 4,
			board: changedBoard,
		});
	});

	it("makes matching imports idempotent, conflicting receipts fail closed, and receipts immutable", async () => {
		const source = createImport("workspace-receipt", "/tmp/workspace-receipt");
		const first = await repository.importLegacyWorkspace(source);
		const rerun = await repository.importLegacyWorkspace(source);
		expect(first.status).toBe("imported");
		expect(rerun).toEqual({
			status: "already-imported",
			receipt: first.receipt,
		});

		await expect(
			repository.importLegacyWorkspace(
				createImport("workspace-receipt", "/tmp/workspace-receipt", "Changed source"),
			),
		).rejects.toBeInstanceOf(PostgresLegacyImportConflictError);

		await expect(
			pool.query(
				`UPDATE ${quotedSchema}.kanban_import_receipts
				 SET source_revision = source_revision + 1
				 WHERE workspace_id = $1`,
				["workspace-receipt"],
			),
		).rejects.toSatisfy((error: unknown) => expectDatabaseCode(error, "55000"));
	});

	it("serializes concurrent matching imports into one import and one idempotent rerun", async () => {
		const source = createImport("workspace-concurrent", "/tmp/workspace-concurrent");
		const results = await Promise.all([
			repository.importLegacyWorkspace(source),
			repository.importLegacyWorkspace(source),
		]);

		expect(results.map((result) => result.status).sort()).toEqual(["already-imported", "imported"]);
		expect(results[0]?.receipt).toEqual(results[1]?.receipt);
		const receiptCount = await pool.query<{ count: string }>(
			`SELECT count(*) AS count
			 FROM ${quotedSchema}.kanban_import_receipts
			 WHERE workspace_id = $1`,
			["workspace-concurrent"],
		);
		expect(receiptCount.rows[0]?.count).toBe("1");
	});

	it("refuses a non-empty target and rolls back an import after a database conflict", async () => {
		await pool.query(
			`INSERT INTO ${quotedSchema}.kanban_workspaces
			 (workspace_id, repo_path, revision, updated_at_ms)
			 VALUES ($1, $2, 0, 0)`,
			["workspace-nonempty", "/tmp/workspace-nonempty"],
		);
		await pool.query(
			`INSERT INTO ${quotedSchema}.kanban_columns
			 (workspace_id, column_id, title, position)
			 VALUES ($1, 'backlog', 'Backlog', 0)`,
			["workspace-nonempty"],
		);
		await expect(
			repository.importLegacyWorkspace(createImport("workspace-nonempty", "/tmp/workspace-nonempty")),
		).rejects.toBeInstanceOf(PostgresLegacyImportConflictError);

		await pool.query(
			`INSERT INTO ${quotedSchema}.kanban_workspaces
			 (workspace_id, repo_path, revision, updated_at_ms)
			 VALUES ($1, $2, 0, 0)`,
			["workspace-existing-path", "/tmp/conflicting-repo-path"],
		);
		await expect(
			repository.importLegacyWorkspace(createImport("workspace-rollback", "/tmp/conflicting-repo-path")),
		).rejects.toSatisfy((error: unknown) => expectDatabaseCode(error, "23505"));

		expect(await repository.loadWorkspace("workspace-rollback")).toBeNull();
		const receiptCount = await pool.query<{ count: string }>(
			`SELECT count(*) AS count
			 FROM ${quotedSchema}.kanban_import_receipts
			 WHERE workspace_id = $1`,
			["workspace-rollback"],
		);
		expect(receiptCount.rows[0]?.count).toBe("0");
	});

	it("enforces legal columns, self-link rejection, and unique dependency edges in PostgreSQL", async () => {
		await repository.importLegacyWorkspace(createImport("workspace-constraints", "/tmp/workspace-constraints"));

		await expect(
			pool.query(
				`INSERT INTO ${quotedSchema}.kanban_columns
				 (workspace_id, column_id, title, position)
				 VALUES ($1, 'illegal', 'Illegal', 99)`,
				["workspace-constraints"],
			),
		).rejects.toSatisfy((error: unknown) => expectDatabaseCode(error, "23514"));

		await expect(
			pool.query(
				`INSERT INTO ${quotedSchema}.kanban_cards
				 (workspace_id, card_id, column_id, position, card_json)
				 VALUES ($1, '', 'review', 99, '{"id":""}'::jsonb)`,
				["workspace-constraints"],
			),
		).rejects.toSatisfy((error: unknown) => expectDatabaseCode(error, "23514"));

		await expect(
			pool.query(
				`INSERT INTO ${quotedSchema}.kanban_dependencies
				 (workspace_id, dependency_id, from_task_id, to_task_id, position, created_at_ms)
				 VALUES ($1, 'self', 'task-a', 'task-a', 99, 0)`,
				["workspace-constraints"],
			),
		).rejects.toSatisfy((error: unknown) => expectDatabaseCode(error, "23514"));

		await expect(
			pool.query(
				`INSERT INTO ${quotedSchema}.kanban_dependencies
				 (workspace_id, dependency_id, from_task_id, to_task_id, position, created_at_ms)
				 VALUES ($1, 'duplicate-edge', 'task-a', 'task-b', 99, 0)`,
				["workspace-constraints"],
			),
		).rejects.toSatisfy((error: unknown) => expectDatabaseCode(error, "23505"));

		await expect(
			pool.query(
				`INSERT INTO ${quotedSchema}.kanban_dependencies
				 (workspace_id, dependency_id, from_task_id, to_task_id, position, created_at_ms)
				 VALUES ($1, 'negative-time', 'task-b', 'task-a', 99, -1)`,
				["workspace-constraints"],
			),
		).rejects.toSatisfy((error: unknown) => expectDatabaseCode(error, "23514"));
	});

	it("creates no session, process, execution, promotion, or projection tables", async () => {
		const tables = await pool.query<{ table_name: string }>(
			`SELECT table_name
			 FROM information_schema.tables
			 WHERE table_schema = $1
			 ORDER BY table_name`,
			[schema],
		);
		expect(tables.rows.map((row) => row.table_name)).toEqual([
			"kanban_cards",
			"kanban_columns",
			"kanban_dependencies",
			"kanban_import_receipts",
			"kanban_schema_migrations",
			"kanban_workspaces",
		]);
	});
});
