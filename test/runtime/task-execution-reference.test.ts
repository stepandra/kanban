import { describe, expect, it } from "vitest";

import {
	assertCurrentTaskExecutionReference,
	formatTaskExecutionReference,
	incrementTaskGeneration,
	parseTaskExecutionReference,
	resolveTaskGeneration,
} from "../../src/core/task-execution-reference";

describe("task execution references", () => {
	it("round-trips a generation-fenced task reference", () => {
		const reference = formatTaskExecutionReference("abc12", 3);

		expect(reference).toBe("abc12~g3");
		expect(parseTaskExecutionReference(reference)).toEqual({
			taskId: "abc12",
			generation: 3,
			resumeFromTrash: false,
		});
	});

	it("carries resume intent without changing generation identity", () => {
		const reference = formatTaskExecutionReference("abc12", 3, { resumeFromTrash: true });

		expect(reference).toBe("abc12~g3~resume");
		expect(parseTaskExecutionReference(reference)).toEqual({
			taskId: "abc12",
			generation: 3,
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
});
