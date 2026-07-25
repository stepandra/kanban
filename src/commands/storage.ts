import { resolve } from "node:path";
import type { Command } from "commander";

import { importIndexedJsonWorkspace } from "../persistence/legacy-json-importer";
import { PostgresKanbanBoardRepository } from "../persistence/postgres/postgres-board-repository";
import { createKanbanPostgresPool, loadKanbanPostgresConfig } from "../persistence/postgres/postgres-config";
import { migrateKanbanPostgres } from "../persistence/postgres/postgres-migrations";

function writeJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function registerStorageCommand(program: Command): void {
	const storage = program
		.command("storage")
		.description("Explicit opt-in storage setup commands. JSON remains the default runtime storage.");

	storage
		.command("import-json")
		.description("Import one indexed JSON workspace into PostgreSQL without enabling runtime cutover.")
		.option("--project-path <path>", "Indexed workspace path. Defaults to the current workspace.")
		.addHelpText("after", "\nRequires KANBAN_DATABASE_URL. This command does not enable PostgreSQL runtime storage.")
		.action(async (options: { projectPath?: string }) => {
			const pool = createKanbanPostgresPool(loadKanbanPostgresConfig());
			try {
				await migrateKanbanPostgres(pool);
				const repository = new PostgresKanbanBoardRepository(pool);
				const result = await importIndexedJsonWorkspace(resolve(options.projectPath ?? process.cwd()), repository);
				writeJson({
					ok: true,
					action: "import-json",
					status: result.status,
					receipt: result.receipt,
					runtimeStorageChanged: false,
				});
			} finally {
				await pool.end();
			}
		});
}
