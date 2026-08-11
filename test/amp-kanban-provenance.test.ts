import { describe, expect, it } from "vitest";

import { assertExpectedKanbanRevision, buildTaskArgs, parseKanbanProvenance } from "../amp/kanban";

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

	it("uses the explicit trash command instead of the legacy done alias", () => {
		expect(
			buildTaskArgs(
				{
					action: "trash",
					taskId: "task-1",
				},
				"/workspace",
			),
		).toEqual(["task", "trash", "--task-id", "task-1", "--project-path", "/workspace"]);
	});

	it("rejects an executable from a different published revision", () => {
		const expectedRevision = "a".repeat(40);
		const provenance = parseKanbanProvenance(
			JSON.stringify({
				schema: "stepandra-kanban-provenance/v1",
				repository: "https://github.com/stepandra/kanban",
				version: "0.1.70",
				revision: "b".repeat(40),
			}),
		);

		expect(() => assertExpectedKanbanRevision(provenance, expectedRevision)).toThrow(
			`this plugin requires ${expectedRevision}`,
		);
	});
});
