import type { RuntimeTaskExecutionAttemptReference } from "./api-contract";

const TASK_EXECUTION_REFERENCE_PATTERN =
	/^(?<taskId>.+)~g(?<generation>[1-9]\d*)(?:~q(?<queuedAt>[1-9]\d*))?(?<resume>~resume)?$/;

export interface TaskExecutionReference {
	taskId: string;
	generation: number;
	queuedAt: number | null;
	resumeFromTrash: boolean;
}

export function resolveTaskGeneration(generation: number | undefined): number {
	return generation ?? 1;
}

export function incrementTaskGeneration(generation: number | undefined): number {
	const currentGeneration = resolveTaskGeneration(generation);
	if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 1) {
		throw new Error("Task generation must be a positive safe integer.");
	}
	if (currentGeneration === Number.MAX_SAFE_INTEGER) {
		throw new Error("Task generation cannot be incremented beyond Number.MAX_SAFE_INTEGER.");
	}
	return currentGeneration + 1;
}

export function formatTaskExecutionReference(
	taskId: string,
	generation: number | undefined,
	options: { queuedAt?: number; resumeFromTrash?: boolean } = {},
): string {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		throw new Error("Task ID cannot be empty.");
	}
	const resolvedGeneration = resolveTaskGeneration(generation);
	if (!Number.isSafeInteger(resolvedGeneration) || resolvedGeneration < 1) {
		throw new Error("Task generation must be a positive safe integer.");
	}
	if (options.queuedAt !== undefined && (!Number.isSafeInteger(options.queuedAt) || options.queuedAt < 1)) {
		throw new Error("Task execution queue time must be a positive safe integer.");
	}
	return `${normalizedTaskId}~g${resolvedGeneration}${options.queuedAt === undefined ? "" : `~q${options.queuedAt}`}${options.resumeFromTrash ? "~resume" : ""}`;
}

export function parseTaskExecutionReference(reference: string): TaskExecutionReference {
	const normalizedReference = reference.trim();
	const match = TASK_EXECUTION_REFERENCE_PATTERN.exec(normalizedReference);
	const taskId = match?.groups?.taskId?.trim();
	const generationText = match?.groups?.generation;
	const generation = generationText ? Number(generationText) : Number.NaN;
	const queuedAtText = match?.groups?.queuedAt;
	const queuedAt = queuedAtText ? Number(queuedAtText) : null;
	if (
		!taskId ||
		!Number.isSafeInteger(generation) ||
		generation < 1 ||
		(queuedAt !== null && (!Number.isSafeInteger(queuedAt) || queuedAt < 1))
	) {
		throw new Error(
			`Invalid task execution reference "${reference}". Expected a generation-fenced reference such as "task-id~g1~q123".`,
		);
	}
	return {
		taskId,
		generation,
		queuedAt,
		resumeFromTrash: Boolean(match?.groups?.resume),
	};
}

export function assertCurrentTaskExecutionReference(
	reference: TaskExecutionReference,
	taskId: string,
	generation: number | undefined,
): void {
	const normalizedTaskId = taskId.trim();
	const currentGeneration = resolveTaskGeneration(generation);
	if (reference.taskId !== normalizedTaskId) {
		throw new Error(
			`Task execution reference targets "${reference.taskId}", but the resolved task is "${normalizedTaskId}".`,
		);
	}
	if (reference.generation !== currentGeneration) {
		throw new Error(
			`Stale task execution reference for "${normalizedTaskId}": queued generation ${reference.generation}, current generation ${currentGeneration}.`,
		);
	}
}

export function assertCurrentTaskExecutionAttempt(
	reference: TaskExecutionReference,
	execution: RuntimeTaskExecutionAttemptReference | undefined,
	attemptId: string,
): void {
	const normalizedAttemptId = attemptId.trim();
	if (
		!normalizedAttemptId ||
		!execution ||
		execution.generation !== reference.generation ||
		(reference.queuedAt !== null && execution.queuedAt !== reference.queuedAt) ||
		execution.attemptId !== normalizedAttemptId
	) {
		throw new Error(
			`Stale task execution attempt for "${reference.taskId}": worker attempt "${normalizedAttemptId || "unknown"}" is not the current persisted attempt.`,
		);
	}
}

export async function waitForCurrentTaskExecutionAttempt(
	reference: TaskExecutionReference,
	attemptId: string,
	loadExecution: () => Promise<RuntimeTaskExecutionAttemptReference | undefined>,
	options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<RuntimeTaskExecutionAttemptReference> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const pollIntervalMs = options.pollIntervalMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const execution = await loadExecution();
		if (
			execution?.attemptId === attemptId.trim() &&
			execution.generation === reference.generation &&
			(reference.queuedAt === null || execution.queuedAt === reference.queuedAt)
		) {
			return execution;
		}
		if (
			reference.queuedAt === null ||
			(execution?.generation === reference.generation && execution.queuedAt >= reference.queuedAt) ||
			Date.now() >= deadline
		) {
			assertCurrentTaskExecutionAttempt(reference, execution, attemptId);
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, pollIntervalMs);
		});
	}
}
