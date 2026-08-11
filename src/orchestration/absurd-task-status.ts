import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
	RuntimeSystemReadinessCheck,
	RuntimeTaskExecutionAttemptReference,
	RuntimeTaskExecutionProjection,
} from "../core/api-contract";

const execFileAsync = promisify(execFile);

function readLine(output: string, label: string): string | null {
	const match = output.match(new RegExp(`^${label}:\\s*(.+)$`, "imu"));
	return match?.[1]?.trim() || null;
}

function normalizeStatus(value: string | null): RuntimeTaskExecutionProjection["status"] {
	switch (value?.toLowerCase()) {
		case "pending":
		case "queued":
			return "pending";
		case "running":
			return "running";
		case "sleeping":
		case "retrying":
			return "sleeping";
		case "completed":
		case "succeeded":
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
		case "canceled":
			return "cancelled";
		default:
			return "unknown";
	}
}

export function parseAbsurdTaskDump(
	reference: RuntimeTaskExecutionAttemptReference,
	output: string,
): RuntimeTaskExecutionProjection {
	const attemptMatch = readLine(output, "Attempt")?.match(/^(\d+)\s+of\s+(\d+)$/u);
	return {
		...reference,
		status: normalizeStatus(readLine(output, "Current status")),
		runId: readLine(output, "Run ID"),
		currentAttempt: attemptMatch ? Number(attemptMatch[1]) : null,
		maxAttempts: attemptMatch ? Number(attemptMatch[2]) : null,
		createdAt: readLine(output, "Created"),
		updatedAt: readLine(output, "Updated"),
	};
}

export async function getAbsurdTaskProjection(
	reference: RuntimeTaskExecutionAttemptReference,
): Promise<RuntimeTaskExecutionProjection> {
	const absurdctl = process.env.ABSURDCTL_BIN ?? "absurdctl";
	try {
		const { stdout } = await execFileAsync(absurdctl, ["dump-task", "--task-id", reference.attemptId], {
			encoding: "utf8",
			timeout: 5_000,
		});
		return parseAbsurdTaskDump(reference, stdout);
	} catch (error) {
		return {
			...reference,
			status: "unknown",
			runId: null,
			currentAttempt: null,
			maxAttempts: null,
			createdAt: null,
			updatedAt: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function getAbsurdTaskProjections(
	references: RuntimeTaskExecutionAttemptReference[],
): Promise<RuntimeTaskExecutionProjection[]> {
	const results = new Array<RuntimeTaskExecutionProjection>(references.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (nextIndex < references.length) {
			const index = nextIndex;
			nextIndex += 1;
			const reference = references[index];
			if (reference) {
				results[index] = await getAbsurdTaskProjection(reference);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(4, references.length) }, async () => await worker()));
	return results;
}

async function commandCheck(binary: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
	try {
		const { stdout, stderr } = await execFileAsync(binary, args, { encoding: "utf8", timeout: 5_000 });
		return { ok: true, detail: (stdout || stderr).trim().split("\n")[0] || "Available" };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

function describeWorkerStatus(check: { ok: boolean; detail: string }): {
	status: RuntimeSystemReadinessCheck["status"];
	detail: string;
} {
	if (!check.ok) {
		return { status: "unavailable", detail: check.detail };
	}
	try {
		const payload = JSON.parse(check.detail) as { state?: unknown };
		if (payload.state === "running") {
			return { status: "ready", detail: "Worker is running." };
		}
		if (payload.state === "stopped") {
			return { status: "stopped", detail: "Worker is stopped. No tasks will execute." };
		}
	} catch {
		// Fall back to the textual status returned by older Juja versions.
	}
	return /running/iu.test(check.detail)
		? { status: "ready", detail: check.detail }
		: { status: "stopped", detail: check.detail };
}

export async function getSystemReadiness(workspacePath: string): Promise<RuntimeSystemReadinessCheck[]> {
	const absurdctl = process.env.ABSURDCTL_BIN ?? "absurdctl";
	const juja = process.env.JUJA_BIN ?? "juja";
	const [queue, worker, jj, amp, workers] = await Promise.all([
		commandCheck(absurdctl, ["list-tasks", "--limit", "1"]),
		commandCheck(juja, ["absurd", "worker", "status"]),
		commandCheck("jj", ["--no-pager", "root"]),
		commandCheck("amp", ["--version"]),
		Promise.all(
			["claude", "codex", "grok", "kimi"].map(async (binary) => {
				const check = await commandCheck("which", [binary]);
				return check.ok ? binary : null;
			}),
		),
	]);
	const availableWorkers = workers.filter((workerName): workerName is string => workerName !== null);
	const workerStatus = describeWorkerStatus(worker);
	void workspacePath;
	return [
		{
			id: "absurd_queue",
			label: "Absurd queue",
			status: queue.ok ? "ready" : "unavailable",
			detail: queue.ok ? "Read-only scheduler access is available." : queue.detail,
		},
		{
			id: "absurd_worker",
			label: "Absurd worker",
			status: workerStatus.status,
			detail: workerStatus.detail,
		},
		{
			id: "jujutsu",
			label: "Jujutsu workspace",
			status: jj.ok ? "ready" : "unavailable",
			detail: jj.ok ? "Native jj repository detected." : jj.detail,
		},
		{
			id: "amp_architect",
			label: "Amp Architect",
			status: amp.ok ? "ready" : "unavailable",
			detail: amp.ok ? `Architect CLI ${amp.detail}` : amp.detail,
		},
		{
			id: "worker_commands",
			label: "Worker commands",
			status: availableWorkers.length === 4 ? "ready" : availableWorkers.length > 0 ? "degraded" : "unavailable",
			detail: availableWorkers.length > 0 ? availableWorkers.join(", ") : "No supported worker commands found.",
		},
	];
}
