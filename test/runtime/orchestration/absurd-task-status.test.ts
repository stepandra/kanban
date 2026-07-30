import { describe, expect, it } from "vitest";

import { parseAbsurdTaskDump } from "../../../src/orchestration/absurd-task-status";

describe("parseAbsurdTaskDump", () => {
	it("projects scheduler-owned state onto a retained attempt reference", () => {
		expect(
			parseAbsurdTaskDump(
				{ attemptId: "attempt-1", generation: 3, queuedAt: 10 },
				[
					"Current status: running",
					"Task ID: attempt-1",
					"Run ID: run-2",
					"Created: Jul 31 01:00",
					"Updated: Jul 31 01:02",
					"Attempt: 2 of 4",
				].join("\n"),
			),
		).toEqual({
			attemptId: "attempt-1",
			generation: 3,
			queuedAt: 10,
			status: "running",
			runId: "run-2",
			currentAttempt: 2,
			maxAttempts: 4,
			createdAt: "Jul 31 01:00",
			updatedAt: "Jul 31 01:02",
		});
	});
});
