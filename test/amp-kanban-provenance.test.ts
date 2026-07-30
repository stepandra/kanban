import { describe, expect, it } from "vitest";

import { buildTaskArgs } from "../amp/kanban";

describe("Amp Kanban task provenance", () => {
	it("adds the current Architect thread only when creating a task", () => {
		const threadId = "T-019fb3aa-000b-752a-a88e-337592dae657";
		const createArgs = buildTaskArgs(
			{
				action: "create",
				title: "Task",
				prompt: "Do the work",
				agentId: "codex",
			},
			"/workspace",
			threadId,
		);
		const updateArgs = buildTaskArgs(
			{
				action: "update",
				taskId: "task-1",
				prompt: "Updated work",
			},
			"/workspace",
			threadId,
		);

		expect(createArgs).toContain("--origin-amp-thread-id");
		expect(createArgs).toContain(threadId);
		expect(updateArgs).not.toContain("--origin-amp-thread-id");
		expect(updateArgs).not.toContain(threadId);
	});
});
