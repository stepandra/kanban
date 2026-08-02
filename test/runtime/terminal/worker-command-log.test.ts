import { describe, expect, it } from "vitest";

import { sanitizeWorkerCommand, WorkerCommandLog } from "../../../src/terminal/worker-command-log";

function createAttempt(overrides: Partial<Parameters<WorkerCommandLog["record"]>[0]> = {}) {
	return {
		taskId: "task-1",
		agentId: "codex" as const,
		cwd: "/tmp/task-1",
		binary: "zmx",
		args: ["attach", "kanban.workspace.codex.task-1.0123456789ab", "codex", "--full-auto", "Implement it"],
		prompt: "Implement it",
		startedAt: 1_000,
		...overrides,
	};
}

describe("WorkerCommandLog", () => {
	it("keeps useful launch arguments while redacting prompts and sensitive option values", () => {
		expect(
			sanitizeWorkerCommand(
				createAttempt({
					args: [
						"attach",
						"kanban.workspace.codex.task-1.0123456789ab",
						"codex",
						"--api-key",
						"secret-value",
						"--token=another-secret",
						"OPENAI_API_KEY=env-shaped-secret",
						"prefix Implement it suffix",
					],
				}),
			),
		).toEqual([
			"zmx",
			"attach",
			"kanban.workspace.codex.task-1.0123456789ab",
			"codex",
			"--api-key",
			"<redacted>",
			"--token=<redacted>",
			"OPENAI_API_KEY=<redacted>",
			"<task-prompt>",
		]);
	});

	it("keeps the newest 200 attempts and returns defensive copies", () => {
		const log = new WorkerCommandLog();
		for (let index = 0; index < 205; index += 1) {
			log.record(createAttempt({ taskId: `task-${index}`, startedAt: index }), {
				status: "started",
				pid: index + 100,
			});
		}

		const entries = log.list();
		expect(entries).toHaveLength(200);
		expect(entries[0]).toMatchObject({ taskId: "task-204", pid: 304 });
		expect(entries.at(-1)).toMatchObject({ taskId: "task-5", pid: 105 });

		entries[0]?.command.push("mutated");
		expect(log.list()[0]?.command).not.toContain("mutated");
	});

	it("records spawn failures without a pid", () => {
		const log = new WorkerCommandLog();
		const entry = log.record(createAttempt(), { status: "failed", error: "ENOENT" });

		expect(entry).toMatchObject({
			status: "failed",
			pid: null,
			error: "ENOENT",
		});
	});
});
