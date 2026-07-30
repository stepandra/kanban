const TASK_EXECUTION_REFERENCE_PATTERN = /^(?<taskId>.+)~g(?<generation>[1-9]\d*)(?<resume>~resume)?$/;

export interface TaskExecutionReference {
	taskId: string;
	generation: number;
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
	options: { resumeFromTrash?: boolean } = {},
): string {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		throw new Error("Task ID cannot be empty.");
	}
	const resolvedGeneration = resolveTaskGeneration(generation);
	if (!Number.isSafeInteger(resolvedGeneration) || resolvedGeneration < 1) {
		throw new Error("Task generation must be a positive safe integer.");
	}
	return `${normalizedTaskId}~g${resolvedGeneration}${options.resumeFromTrash ? "~resume" : ""}`;
}

export function parseTaskExecutionReference(reference: string): TaskExecutionReference {
	const normalizedReference = reference.trim();
	const match = TASK_EXECUTION_REFERENCE_PATTERN.exec(normalizedReference);
	const taskId = match?.groups?.taskId?.trim();
	const generationText = match?.groups?.generation;
	const generation = generationText ? Number(generationText) : Number.NaN;
	if (!taskId || !Number.isSafeInteger(generation) || generation < 1) {
		throw new Error(
			`Invalid task execution reference "${reference}". Expected a generation-fenced reference such as "task-id~g1".`,
		);
	}
	return {
		taskId,
		generation,
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
