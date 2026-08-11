import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RuntimeAgentId } from "../core/api-contract";

const execFileAsync = promisify(execFile);

export interface EnqueueAbsurdTaskStartInput {
	taskExecutionReference: string;
	projectPath: string;
	agentId: RuntimeAgentId;
}

export interface AbsurdTaskStartReceipt {
	attemptId: string;
	raw: unknown;
}

function readAttemptId(value: unknown): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const record = value as Record<string, unknown>;
	for (const key of ["task_id", "taskId", "id"]) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	for (const key of ["task", "data", "result"]) {
		const nested = readAttemptId(record[key]);
		if (nested) {
			return nested;
		}
	}
	return null;
}

export async function enqueueAbsurdTaskStart(input: EnqueueAbsurdTaskStartInput): Promise<AbsurdTaskStartReceipt> {
	const juja = process.env.JUJA_BIN ?? "juja";
	let stdout: string;
	try {
		({ stdout } = await execFileAsync(
			juja,
			[
				"kanban-enqueue",
				"--task-id",
				input.taskExecutionReference,
				"--project-path",
				input.projectPath,
				"--agent",
				input.agentId,
			],
			{ encoding: "utf8", timeout: 10_000 },
		));
	} catch (error) {
		const message = error instanceof Error && error.message.trim() ? error.message : String(error);
		throw new Error(`Could not enqueue task through Absurd: ${message}`);
	}

	try {
		const raw: unknown = JSON.parse(stdout);
		const attemptId = readAttemptId(raw);
		if (!attemptId) {
			throw new Error("Absurd enqueue receipt did not include a task ID.");
		}
		return { attemptId, raw };
	} catch {
		throw new Error("Absurd enqueue returned invalid JSON or no task ID.");
	}
}
