import type { Command } from "commander";

import { inspectJjRepositoryHealth } from "../workspace/jj-doctor";

export function registerJjCommand(program: Command): void {
	const jj = program.command("jj").description("Inspect jj repositories that back Kanban task workspaces.");

	jj.command("doctor")
		.description("Report a read-only jj workspace and task-workspace health inventory.")
		.option("--project-path <path>", "Repository path. Defaults to the current directory.")
		.action(async (options: { projectPath?: string }) => {
			const report = await inspectJjRepositoryHealth({ cwd: options.projectPath ?? process.cwd() });
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
			if (!report.ok) {
				process.exitCode = 1;
			}
		});
}
