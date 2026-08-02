import type { RuntimeAgentId, RuntimeWorkerCommandLogEntry } from "../core/api-contract";

const MAX_WORKER_COMMAND_LOG_ENTRIES = 200;
const MAX_VISIBLE_ARGUMENT_LENGTH = 512;
const MAX_VISIBLE_ERROR_LENGTH = 2_048;
const SENSITIVE_OPTION_PATTERN = /(?:api[-_]?key|authorization|bearer|cookie|credential|password|secret|token)/iu;
const SENSITIVE_ASSIGNMENT_PATTERN =
	/^(?:[A-Za-z0-9_]*(?:API_KEY|AUTHORIZATION|BEARER|COOKIE|CREDENTIAL|PASSWORD|SECRET|TOKEN)[A-Za-z0-9_]*)=/iu;

export interface WorkerCommandAttempt {
	taskId: string;
	agentId: RuntimeAgentId;
	cwd: string;
	binary: string;
	args: string[];
	prompt: string;
	startedAt: number;
}

function sanitizeOptionValue(arg: string): string {
	const equalsIndex = arg.indexOf("=");
	if (equalsIndex === -1) {
		return arg;
	}
	return `${arg.slice(0, equalsIndex + 1)}<redacted>`;
}

function truncateVisibleValue(value: string): string {
	return value.length > MAX_VISIBLE_ARGUMENT_LENGTH ? `<redacted:${value.length} chars>` : value;
}

export function sanitizeWorkerCommand(attempt: WorkerCommandAttempt): string[] {
	const prompt = attempt.prompt.trim();
	let redactNextArgument = false;
	const args = attempt.args.map((arg) => {
		if (redactNextArgument) {
			redactNextArgument = false;
			return "<redacted>";
		}
		if (arg.startsWith("-") && SENSITIVE_OPTION_PATTERN.test(arg)) {
			if (!arg.includes("=")) {
				redactNextArgument = true;
			}
			return sanitizeOptionValue(arg);
		}
		if (SENSITIVE_ASSIGNMENT_PATTERN.test(arg)) {
			return `${arg.slice(0, arg.indexOf("=") + 1)}<redacted>`;
		}
		if (prompt && arg.includes(prompt)) {
			return "<task-prompt>";
		}
		return truncateVisibleValue(arg);
	});
	return [truncateVisibleValue(attempt.binary), ...args];
}

export class WorkerCommandLog {
	private readonly entries: RuntimeWorkerCommandLogEntry[] = [];
	private sequence = 0;

	record(
		attempt: WorkerCommandAttempt,
		result: { status: "started"; pid: number } | { status: "failed"; error: string },
	): RuntimeWorkerCommandLogEntry {
		this.sequence += 1;
		const entry: RuntimeWorkerCommandLogEntry = {
			id: `${attempt.startedAt}-${this.sequence}`,
			taskId: attempt.taskId,
			agentId: attempt.agentId,
			cwd: attempt.cwd,
			command: sanitizeWorkerCommand(attempt),
			status: result.status,
			pid: result.status === "started" ? result.pid : null,
			startedAt: attempt.startedAt,
			error: result.status === "failed" ? result.error.slice(0, MAX_VISIBLE_ERROR_LENGTH) : null,
		};
		this.entries.unshift(entry);
		if (this.entries.length > MAX_WORKER_COMMAND_LOG_ENTRIES) {
			this.entries.length = MAX_WORKER_COMMAND_LOG_ENTRIES;
		}
		return { ...entry, command: [...entry.command] };
	}

	list(): RuntimeWorkerCommandLogEntry[] {
		return this.entries.map((entry) => ({ ...entry, command: [...entry.command] }));
	}
}
