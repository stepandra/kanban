import { describe, expect, it, vi } from "vitest";

import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { runtimeAppRouter } from "../../../src/trpc/app-router";

function createContext(isInternalRequest: boolean): RuntimeTrpcContext {
	return {
		requestedWorkspaceId: "workspace-1",
		workspaceScope: {
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		},
		isInternalRequest,
		runtimeApi: {
			startTaskSession: vi.fn(async () => ({
				ok: true,
				summary: null,
			})),
			enqueueTaskExecution: vi.fn(async () => ({
				ok: true,
				state: "queued" as const,
				task: { id: "task-1", generation: 1 },
				attempt: { attemptId: "absurd-1", generation: 1, queuedAt: 1 },
			})),
		} as unknown as RuntimeTrpcContext["runtimeApi"],
		workspaceApi: {} as RuntimeTrpcContext["workspaceApi"],
		projectsApi: {} as RuntimeTrpcContext["projectsApi"],
		hooksApi: {} as RuntimeTrpcContext["hooksApi"],
	};
}

const startRequest = {
	taskId: "task-1",
	prompt: "Implement",
	baseRef: "main",
};

describe("runtime task start authority", () => {
	it("does not expose a worker-reachable per-task read-only acceptance procedure", () => {
		expect(Object.keys(runtimeAppRouter._def.procedures)).not.toContain("workspace.acceptReadOnlyReport");
	});

	it("allows browser callers to enqueue through Absurd", async () => {
		const context = createContext(false);
		const caller = runtimeAppRouter.createCaller(context);

		await expect(caller.runtime.enqueueTaskExecution({ taskId: "task-1" })).resolves.toMatchObject({
			ok: true,
			state: "queued",
		});
	});

	it("rejects direct task-session start from a browser caller", async () => {
		const context = createContext(false);
		const caller = runtimeAppRouter.createCaller(context);

		await expect(caller.runtime.startTaskSession(startRequest)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(context.runtimeApi.startTaskSession).not.toHaveBeenCalled();
	});

	it("allows the internal Absurd worker to attach the task session", async () => {
		const context = createContext(true);
		const caller = runtimeAppRouter.createCaller(context);

		await expect(caller.runtime.startTaskSession(startRequest)).resolves.toMatchObject({
			ok: true,
		});
		expect(context.runtimeApi.startTaskSession).toHaveBeenCalledOnce();
	});
});
