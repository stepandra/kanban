import { describe, expect, it } from "vitest";

import { createAmpTaskWatchRegistry, findOrphanedAmpTaskIds, hasCompletionReceipt } from "../amp/kanban";

describe("hasCompletionReceipt", () => {
	it("accepts the receipt on the final line with trailing whitespace", () => {
		expect(hasCompletionReceipt("done.\n[kanban:submit:t-1:abc]\n\n", "[kanban:submit:t-1:abc]")).toBe(true);
	});

	it("rejects a missing receipt", () => {
		expect(hasCompletionReceipt("done, but no receipt", "[kanban:submit:t-1:abc]")).toBe(false);
	});

	it("rejects a receipt that is not at the end of the response", () => {
		expect(hasCompletionReceipt("[kanban:submit:t-1:abc]\nbut wait, more work", "[kanban:submit:t-1:abc]")).toBe(
			false,
		);
	});

	it("rejects a different task's receipt", () => {
		expect(hasCompletionReceipt("[kanban:submit:t-2:abc]", "[kanban:submit:t-1:abc]")).toBe(false);
	});
});

describe("createAmpTaskWatchRegistry", () => {
	it("resolves cancelled with the reason and forgets the watch", async () => {
		const registry = createAmpTaskWatchRegistry();
		registry.register("t-1", "T-1");

		expect(registry.cancelForTask("t-1", "task done through the kanban_tasks tool")).toBe(true);
		expect(registry.size()).toBe(0);
		expect(registry.cancelForTask("t-1", "again")).toBe(false);
	});

	it("returns false when cancelling an unwatched task", () => {
		const registry = createAmpTaskWatchRegistry();

		expect(registry.cancelForTask("t-missing", "reason")).toBe(false);
	});

	it("restarting a task cancels the previous watch without dropping the new one", async () => {
		const registry = createAmpTaskWatchRegistry();
		const first = registry.register("t-1", "T-1");
		const second = registry.register("t-1", "T-2");

		await expect(first.cancelled).resolves.toBe("replaced by Amp Orb thread T-2");
		expect(registry.size()).toBe(1);
		expect(registry.cancelForTask("t-1", "task done through the kanban_tasks tool")).toBe(true);
		await expect(second.cancelled).resolves.toBe("task done through the kanban_tasks tool");
	});

	it("release after replacement keeps the replacement watch registered", () => {
		const registry = createAmpTaskWatchRegistry();
		const first = registry.register("t-1", "T-1");
		registry.register("t-1", "T-2");

		first.release();

		expect(registry.size()).toBe(1);
	});

	it("cancelOutsideInProgress ends only watches whose task left in_progress", async () => {
		const registry = createAmpTaskWatchRegistry();
		registry.register("t-1", "T-1");
		registry.register("t-2", "T-2");

		const ended = registry.cancelOutsideInProgress(
			new Set(["t-2"]),
			"bulk task delete through the kanban_tasks tool",
		);

		expect(ended).toEqual(["t-1"]);
		expect(registry.size()).toBe(1);
	});
});

describe("findOrphanedAmpTaskIds", () => {
	it("keeps only in-progress tasks owned by amp", () => {
		const orphaned = findOrphanedAmpTaskIds([
			{ id: "t-1", prompt: "p", column: "in_progress", agentId: "amp" },
			{ id: "t-2", prompt: "p", column: "in_progress", agentId: "claude" },
			{ id: "t-3", prompt: "p", column: "review", agentId: "amp" },
			{ id: "t-4", prompt: "p", column: "done", agentId: "amp" },
			{ id: "t-5", prompt: "p", column: "in_progress" },
		]);

		expect(orphaned).toEqual(["t-1"]);
	});

	it("returns an empty list when nothing is orphaned", () => {
		expect(findOrphanedAmpTaskIds([])).toEqual([]);
	});
});
