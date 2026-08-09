import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import type { ZmxSessionControl } from "../../../src/terminal/zmx-agent-session";

const DURABLE_SESSION_NAME = "kanban.ws.codex.task-1.0123456789ab";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function createZmxControlStub(overrides: Partial<ZmxSessionControl> = {}): ZmxSessionControl {
	return {
		listSessionNames: vi.fn(async () => [DURABLE_SESSION_NAME]),
		killSession: vi.fn(async () => {}),
		...overrides,
	};
}

describe("TerminalSessionManager durable sessions", () => {
	afterEach(() => {
		delete process.env.KANBAN_DURABLE_AGENT_SESSIONS;
	});

	describe("hydrateFromRecord", () => {
		it("restores durable-session tracking from the persisted summary", () => {
			const manager = new TerminalSessionManager({ zmxControl: createZmxControlStub() });

			manager.hydrateFromRecord({
				"task-1": createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
				"task-2": createSummary({ taskId: "task-2" }),
			});

			expect(manager.isDurableTaskSession("task-1")).toBe(true);
			expect(manager.isDurableTaskSession("task-2")).toBe(false);
		});

		it("clears durable tracking when the persisted summary has no durable session", () => {
			const manager = new TerminalSessionManager({ zmxControl: createZmxControlStub() });
			manager.hydrateFromRecord({
				"task-1": createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
			});
			expect(manager.isDurableTaskSession("task-1")).toBe(true);

			manager.hydrateFromRecord({
				"task-1": createSummary(),
			});

			expect(manager.isDurableTaskSession("task-1")).toBe(false);
		});

		it("restores persisted attempt ownership for fenced durable cleanup", async () => {
			const killSession = vi.fn(async (_sessionName: string) => {});
			const manager = new TerminalSessionManager({ zmxControl: createZmxControlStub({ killSession }) });
			manager.hydrateFromRecord(
				{
					"task-1": createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
				},
				{
					"task-1": { attemptId: "attempt-2", generation: 1, queuedAt: 20 },
				},
			);

			await expect(manager.stopTaskSession("task-1", null)).resolves.toBeNull();
			await expect(manager.stopTaskSession("task-1", "attempt-1")).resolves.toBeNull();
			expect(killSession).not.toHaveBeenCalled();

			await expect(manager.stopTaskSession("task-1", "attempt-2")).resolves.toMatchObject({
				durableSessionName: null,
			});
			expect(killSession).toHaveBeenCalledOnce();
			expect(killSession).toHaveBeenCalledWith(DURABLE_SESSION_NAME);
		});
	});

	describe("recoverStaleSession", () => {
		it("keeps a live durable session reattachable instead of flipping it to idle", () => {
			const manager = new TerminalSessionManager({ zmxControl: createZmxControlStub() });
			manager.hydrateFromRecord({
				"task-1": createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
			});

			const recovered = manager.recoverStaleSession("task-1");

			expect(recovered?.state).toBe("running");
			expect(recovered?.durableSessionName).toBe(DURABLE_SESSION_NAME);
			expect(recovered?.workspacePath).toBe("/tmp/worktree");
			expect(recovered?.agentId).toBe("codex");
			// The recorded pid belonged to the previous runtime's attach client.
			expect(recovered?.pid).toBeNull();
			expect(manager.isDurableTaskSession("task-1")).toBe(true);
		});

		it("still resets non-durable stale sessions to idle", () => {
			const manager = new TerminalSessionManager({ zmxControl: createZmxControlStub() });
			manager.hydrateFromRecord({
				"task-1": createSummary(),
			});

			const recovered = manager.recoverStaleSession("task-1");

			expect(recovered?.state).toBe("idle");
			expect(recovered?.pid).toBeNull();
		});
	});

	describe("reconcileDurableSessions", () => {
		it("reaps workspace orphans even when no durable summary survived", async () => {
			const killSession = vi.fn(async (_sessionName: string) => {});
			const manager = new TerminalSessionManager({ workspaceId: "ws", warn: vi.fn() });
			const orphanName = "kanban.ws.codex.task-orphan.abcdef012345";

			await manager.reconcileDurableSessions(
				createZmxControlStub({ listSessionNames: async () => [orphanName], killSession }),
			);

			expect(killSession).toHaveBeenCalledWith(orphanName);
		});

		it("keeps persisted durable sessions that are still alive in zmx", async () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
			});

			await manager.reconcileDurableSessions(createZmxControlStub());

			expect(manager.isDurableTaskSession("task-1")).toBe(true);
			const summary = manager.getSummary("task-1");
			expect(summary?.state).toBe("running");
			expect(summary?.durableSessionName).toBe(DURABLE_SESSION_NAME);
		});

		it("clears durable sessions that died while the runtime was down", async () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
			});

			await manager.reconcileDurableSessions(createZmxControlStub({ listSessionNames: async () => [] }));

			expect(manager.isDurableTaskSession("task-1")).toBe(false);
			const summary = manager.getSummary("task-1");
			expect(summary?.state).toBe("idle");
			expect(summary?.durableSessionName).toBeNull();
			expect(summary?.pid).toBeNull();
			// agentId is preserved so trash-restore routing still works.
			expect(summary?.agentId).toBe("codex");
		});

		it("kills orphaned kanban sessions for this workspace and logs a warning", async () => {
			const killSession = vi.fn(async (_sessionName: string) => {});
			const warn = vi.fn();
			const manager = new TerminalSessionManager({ warn });
			manager.hydrateFromRecord({
				"task-1": createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
			});
			const control = createZmxControlStub({
				listSessionNames: async () => [
					DURABLE_SESSION_NAME,
					"kanban.ws.codex.task-orphan.abcdef012345",
					"kanban.other-workspace.codex.task-x.abcdef012345",
					"unrelated-session",
				],
				killSession,
			});

			await manager.reconcileDurableSessions(control);

			expect(killSession).toHaveBeenCalledTimes(1);
			expect(killSession).toHaveBeenCalledWith("kanban.ws.codex.task-orphan.abcdef012345");
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("kanban.ws.codex.task-orphan.abcdef012345"));
			expect(manager.isDurableTaskSession("task-1")).toBe(true);
		});

		it("logs orphan kill failures without throwing", async () => {
			const warn = vi.fn();
			const manager = new TerminalSessionManager({ warn });
			manager.hydrateFromRecord({
				"task-1": createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
			});
			const control = createZmxControlStub({
				listSessionNames: async () => [DURABLE_SESSION_NAME, "kanban.ws.codex.task-orphan.abcdef012345"],
				killSession: async () => {
					throw new Error("zmx exploded");
				},
			});

			await expect(manager.reconcileDurableSessions(control)).resolves.toBeUndefined();
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("zmx exploded"));
		});

		it("does not touch zmx at all when KANBAN_DURABLE_AGENT_SESSIONS=0", async () => {
			process.env.KANBAN_DURABLE_AGENT_SESSIONS = "0";
			const listSessionNames = vi.fn(async () => [] as string[]);
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
			});

			await manager.reconcileDurableSessions(createZmxControlStub({ listSessionNames }));

			expect(listSessionNames).not.toHaveBeenCalled();
		});
	});

	describe("stopTaskSession", () => {
		function seedActiveDurableEntry(
			manager: TerminalSessionManager,
			entry: { active: { session: { stop: ReturnType<typeof vi.fn> } } },
		): void {
			(
				manager as unknown as {
					entries: Map<string, unknown>;
				}
			).entries.set("task-1", entry);
		}

		it("waits for the durable zmx session to stop before returning", async () => {
			const killDeferred = { resolve: undefined as (() => void) | undefined };
			const killSession = vi.fn(
				(_sessionName: string) =>
					new Promise<void>((resolve) => {
						killDeferred.resolve = resolve;
					}),
			);
			const manager = new TerminalSessionManager({ zmxControl: createZmxControlStub({ killSession }) });
			const stop = vi.fn();
			const entry = {
				summary: createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
				active: {
					session: { stop },
					durableSessionName: DURABLE_SESSION_NAME,
					onSessionCleanup: null,
					workspaceTrustConfirmTimer: null,
				},
				listeners: new Map(),
				suppressAutoRestartOnExit: false,
			};
			seedActiveDurableEntry(manager, entry);

			let didStop = false;
			const stopping = manager.stopTaskSession("task-1").then((summary) => {
				didStop = true;
				return summary;
			});
			await Promise.resolve();

			expect(killSession).toHaveBeenCalledTimes(1);
			expect(killSession).toHaveBeenCalledWith(DURABLE_SESSION_NAME);
			expect(didStop).toBe(false);
			expect(stop).not.toHaveBeenCalled();

			killDeferred.resolve?.();
			const summary = await stopping;
			expect(stop).toHaveBeenCalledTimes(1);
			expect(summary?.durableSessionName).toBeNull();
			expect(manager.isDurableTaskSession("task-1")).toBe(false);
		});

		it("stops a hydrated durable session that has no active PTY", async () => {
			const killSession = vi.fn(async (_sessionName: string) => {});
			const manager = new TerminalSessionManager({ zmxControl: createZmxControlStub({ killSession }) });
			manager.hydrateFromRecord({
				"task-1": createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
			});

			const summary = await manager.stopTaskSession("task-1");

			expect(killSession).toHaveBeenCalledWith(DURABLE_SESSION_NAME);
			expect(summary?.durableSessionName).toBeNull();
			expect(manager.isDurableTaskSession("task-1")).toBe(false);
		});

		it("rejects zmx kill failures and keeps the durable session tracked", async () => {
			const warn = vi.fn();
			const killSession = vi.fn(async (_sessionName: string) => {
				throw new Error("kill failed");
			});
			const manager = new TerminalSessionManager({
				zmxControl: createZmxControlStub({ killSession }),
				warn,
			});
			const entry = {
				summary: createSummary({ durableSessionName: DURABLE_SESSION_NAME }),
				active: {
					session: { stop: vi.fn() },
					durableSessionName: DURABLE_SESSION_NAME,
					onSessionCleanup: null,
					workspaceTrustConfirmTimer: null,
				},
				suppressAutoRestartOnExit: false,
			};
			seedActiveDurableEntry(manager, entry);

			await expect(manager.stopTaskSession("task-1")).rejects.toThrow("kill failed");
			expect(warn).toHaveBeenCalledWith(expect.stringContaining(DURABLE_SESSION_NAME));
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("kill failed"));
			expect(entry.active.session.stop).not.toHaveBeenCalled();
			expect(manager.getSummary("task-1")?.durableSessionName).toBe(DURABLE_SESSION_NAME);
		});
	});
});
