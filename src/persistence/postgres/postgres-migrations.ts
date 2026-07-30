import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export interface KanbanPostgresMigration {
	version: number;
	name: string;
	sql: string;
}

export const KANBAN_POSTGRES_MIGRATIONS: readonly KanbanPostgresMigration[] = Object.freeze([
	{
		version: 1,
		name: "board_authority",
		sql: `
			CREATE TABLE kanban_workspaces (
				workspace_id text PRIMARY KEY CHECK (btrim(workspace_id) <> ''),
				repo_path text NOT NULL UNIQUE CHECK (btrim(repo_path) <> ''),
				revision bigint NOT NULL CHECK (revision >= 0),
				updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= 0)
			);

			CREATE TABLE kanban_columns (
				workspace_id text NOT NULL REFERENCES kanban_workspaces(workspace_id) ON DELETE CASCADE,
				column_id text NOT NULL CHECK (column_id IN ('backlog', 'in_progress', 'review', 'trash')),
				title text NOT NULL,
				position integer NOT NULL CHECK (position >= 0),
				PRIMARY KEY (workspace_id, column_id),
				UNIQUE (workspace_id, position)
			);

			CREATE TABLE kanban_cards (
				workspace_id text NOT NULL,
				card_id text NOT NULL CHECK (btrim(card_id) <> ''),
				column_id text NOT NULL,
				position integer NOT NULL CHECK (position >= 0),
				card_json jsonb NOT NULL CHECK (
					jsonb_typeof(card_json) = 'object'
					AND card_json ->> 'id' = card_id
				),
				PRIMARY KEY (workspace_id, card_id),
				UNIQUE (workspace_id, column_id, position),
				FOREIGN KEY (workspace_id, column_id)
					REFERENCES kanban_columns(workspace_id, column_id)
					ON DELETE CASCADE
			);

			CREATE TABLE kanban_dependencies (
				workspace_id text NOT NULL,
				dependency_id text NOT NULL CHECK (btrim(dependency_id) <> ''),
				from_task_id text NOT NULL CHECK (btrim(from_task_id) <> ''),
				to_task_id text NOT NULL CHECK (btrim(to_task_id) <> ''),
				position integer NOT NULL CHECK (position >= 0),
				created_at_ms bigint NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
				PRIMARY KEY (workspace_id, dependency_id),
				UNIQUE (workspace_id, from_task_id, to_task_id),
				UNIQUE (workspace_id, position),
				CHECK (from_task_id <> to_task_id),
				FOREIGN KEY (workspace_id, from_task_id)
					REFERENCES kanban_cards(workspace_id, card_id)
					ON DELETE CASCADE,
				FOREIGN KEY (workspace_id, to_task_id)
					REFERENCES kanban_cards(workspace_id, card_id)
					ON DELETE CASCADE
			);

			CREATE TABLE kanban_import_receipts (
				workspace_id text PRIMARY KEY REFERENCES kanban_workspaces(workspace_id) ON DELETE RESTRICT,
				source_kind text NOT NULL CHECK (source_kind = 'indexed-json-v1'),
				source_checksum text NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
				source_revision bigint NOT NULL CHECK (source_revision >= 0),
				imported_at_ms bigint NOT NULL CHECK (imported_at_ms >= 0),
				card_count integer NOT NULL CHECK (card_count >= 0),
				dependency_count integer NOT NULL CHECK (dependency_count >= 0)
			);

			CREATE FUNCTION kanban_reject_import_receipt_mutation()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				RAISE EXCEPTION 'Kanban import receipts are immutable'
					USING ERRCODE = '55000';
			END;
			$$;

			CREATE TRIGGER kanban_import_receipts_immutable
			BEFORE UPDATE OR DELETE ON kanban_import_receipts
			FOR EACH ROW EXECUTE FUNCTION kanban_reject_import_receipt_mutation();
		`,
	},
	{
		version: 2,
		name: "track_planning_catalog",
		sql: `
			ALTER TABLE kanban_workspaces
			ADD COLUMN planning_json jsonb NOT NULL DEFAULT '{"tracks":[],"milestones":[]}'::jsonb
			CHECK (
				jsonb_typeof(planning_json) = 'object'
				AND jsonb_typeof(planning_json -> 'tracks') = 'array'
				AND jsonb_typeof(planning_json -> 'milestones') = 'array'
			);
		`,
	},
]);

function quoteIdentifier(identifier: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
		throw new Error(`Invalid PostgreSQL schema identifier: ${identifier}`);
	}
	return `"${identifier}"`;
}

async function setTransactionSchema(client: PoolClient, schema: string): Promise<void> {
	await client.query(`SET LOCAL search_path TO ${getKanbanPostgresSchemaSearchPath(schema)}`);
}

export async function migrateKanbanPostgres(pool: Pool, schema = "public"): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await setTransactionSchema(client, schema);
		await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
			`kanban-schema-migrations:${schema}`,
		]);
		await client.query(`
			CREATE TABLE IF NOT EXISTS kanban_schema_migrations (
				version integer PRIMARY KEY CHECK (version > 0),
				name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
				checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
				applied_at timestamptz NOT NULL DEFAULT now()
			)
		`);

		const applied = await client.query<{ version: number; name: string; checksum: string }>(
			"SELECT version, name, checksum FROM kanban_schema_migrations ORDER BY version",
		);
		const appliedByVersion = new Map(applied.rows.map((migration) => [migration.version, migration]));

		for (const migration of KANBAN_POSTGRES_MIGRATIONS) {
			const checksum = createHash("sha256").update(migration.sql).digest("hex");
			const appliedMigration = appliedByVersion.get(migration.version);
			if (appliedMigration !== undefined) {
				if (appliedMigration.name !== migration.name || appliedMigration.checksum !== checksum) {
					throw new Error(
						`PostgreSQL migration ${migration.version} does not match the immutable ` +
							`"${migration.name}" migration in this Kanban build.`,
					);
				}
				continue;
			}
			await client.query(migration.sql);
			await client.query("INSERT INTO kanban_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
				migration.version,
				migration.name,
				checksum,
			]);
		}

		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export function getKanbanPostgresSchemaSearchPath(schema: string): string {
	return quoteIdentifier(schema);
}
