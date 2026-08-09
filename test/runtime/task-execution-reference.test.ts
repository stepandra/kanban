import { describe, expect, it } from "vitest";

import {
	assertCurrentTaskExecutionAttempt,
	assertCurrentTaskExecutionReference,
	formatTaskExecutionReference,
	incrementTaskGeneration,
	parseTaskExecutionReference,
	resolveTaskGeneration,
	waitForCurrentTaskExecutionAttempt,
} from "../../src/core/task-execution-reference";

describe("task execution references", () => {
	it("round-trips a generation-fenced task reference", () => {
		const reference = formatTaskExecutionReference("abc12", 3);

		expect(reference).toBe("abc12~g3");
		expect(parseTaskExecutionReference(reference)).toEqual({
			taskId: "abc12",
			generation: 3,
			queuedAt: null,
			resumeFromTrash: false,
		});
	});

	it("carries a unique queue fence and resume intent without changing generation identity", () => {
		const reference = formatTaskExecutionReference("abc12", 3, { queuedAt: 123, resumeFromTrash: true });

		expect(reference).toBe("abc12~g3~q123~resume");
		expect(parseTaskExecutionReference(reference)).toEqual({
			taskId: "abc12",
			generation: 3,
			queuedAt: 123,
			resumeFromTrash: true,
		});
	});

	it("treats legacy tasks without a stored generation as generation one", () => {
		expect(resolveTaskGeneration(undefined)).toBe(1);
		expect(formatTaskExecutionReference("abc12", undefined)).toBe("abc12~g1");
		expect(incrementTaskGeneration(undefined)).toBe(2);
	});

	it("rejects raw task IDs and malformed generations at the internal worker boundary", () => {
		expect(() => parseTaskExecutionReference("abc12")).toThrow("generation-fenced reference");
		expect(() => parseTaskExecutionReference("abc12~g0")).toThrow("generation-fenced reference");
		expect(() => parseTaskExecutionReference("abc12~g1.5")).toThrow("generation-fenced reference");
	});

	it("rejects a queued generation after the task execution contract changes", () => {
		const queued = parseTaskExecutionReference("abc12~g1");

		expect(() => assertCurrentTaskExecutionReference(queued, "abc12", 2)).toThrow(
			'Stale task execution reference for "abc12": queued generation 1, current generation 2.',
		);
	});

	it("accepts only the current persisted Absurd attempt", () => {
		const queued = parseTaskExecutionReference("abc12~g2~q10~resume");
		const currentAttempt = { attemptId: "attempt-2", generation: 2, queuedAt: 10 };

		expect(() => assertCurrentTaskExecutionAttempt(queued, currentAttempt, "attempt-2")).not.toThrow();
		expect(() => assertCurrentTaskExecutionAttempt(queued, undefined, "attempt-2")).toThrow(
			"is not the current persisted attempt",
		);
		expect(() => assertCurrentTaskExecutionAttempt(queued, currentAttempt, "attempt-1")).toThrow(
			"is not the current persisted attempt",
		);
		expect(() =>
			assertCurrentTaskExecutionAttempt(queued, { ...currentAttempt, generation: 1 }, "attempt-2"),
		).toThrow("is not the current persisted attempt");
	});

	it("waits for a worker's receipt when the worker runs before enqueue persistence", async () => {
		const queued = parseTaskExecutionReference("abc12~g2~q20");
		const observations = [
			undefined,
			{ attemptId: "attempt-older", generation: 2, queuedAt: 10 },
			{ attemptId: "attempt-current", generation: 2, queuedAt: 20 },
		];
		const loadExecution = async () => observations.shift();

		await expect(
			waitForCurrentTaskExecutionAttempt(queued, "attempt-current", loadExecution, { pollIntervalMs: 0 }),
		).resolves.toEqual({ attemptId: "attempt-current", generation: 2, queuedAt: 20 });
	});

	it("fails immediately when a newer enqueue receipt supersedes the worker", async () => {
		const queued = parseTaskExecutionReference("abc12~g2~q20");
		const loadExecution = async () => ({ attemptId: "attempt-newer", generation: 2, queuedAt: 21 });

		await expect(
			waitForCurrentTaskExecutionAttempt(queued, "attempt-current", loadExecution, { pollIntervalMs: 0 }),
		).rejects.toThrow("is not the current persisted attempt");
	});
});
