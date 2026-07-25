import { Pool, type PoolConfig } from "pg";

const KANBAN_DATABASE_URL_ENV = "KANBAN_DATABASE_URL";

export interface KanbanPostgresConfig {
	connectionString: string;
}

export function loadKanbanPostgresConfig(environment: NodeJS.ProcessEnv = process.env): KanbanPostgresConfig {
	const connectionString = environment[KANBAN_DATABASE_URL_ENV]?.trim();
	if (!connectionString) {
		throw new Error(
			`${KANBAN_DATABASE_URL_ENV} is required for the explicit PostgreSQL storage command. ` +
				"JSON remains the default Kanban storage.",
		);
	}
	return { connectionString };
}

export function createKanbanPostgresPool(
	config: KanbanPostgresConfig,
	overrides: Omit<PoolConfig, "connectionString"> = {},
): Pool {
	return new Pool({
		...overrides,
		connectionString: config.connectionString,
		application_name: "kanban-postgres-storage",
	});
}
