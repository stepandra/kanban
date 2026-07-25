/**
 * Unit tests for the runtime state hub stream hot paths.
 *
 * BA-14: swallowed stream failures (websocket writes, projects payload builds,
 * workspace-state rebuilds) must emit rate-limited warn-level logs with context.
 *
 * PF-19: plain session ticks must not re-read boards or rebuild workspace
 * snapshots; project-count broadcasts are debounced and only happen when a
 * count-relevant session state actually changed, and turn-checkpoint changes
 * stream deltas instead of full workspace snapshots.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { WebSocket } from "ws";

import type {
	RuntimeBoardData,
	RuntimeStateStreamMessage,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import {
	type CreateRuntimeStateHubDependencies,
	createRuntimeStateHub,
	type RuntimeStateHub,
} from "../../../src/server/runtime-state-hub";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

const TEST_WORKSPACE_ID = "ws-1";
const TEST_WORKSPACE_PATH = "/fake/ws-1";

type WorkspaceRegistryStub = CreateRuntimeStateHubDependencies["workspaceRegistry"];

interface HubTestContext {
	hub: RuntimeStateHub;
	warn: Mock<(message: string) => void>;
	persistTaskSessionSummary: Mock<CreateRuntimeStateHubDependencies["persistTaskSessionSummary"]>;
	workspaceRegistry: {
		resolveWorkspaceForStream: Mock<WorkspaceRegistryStub["resolveWorkspaceForStream"]>;
		buildProjectsPayload: Mock<WorkspaceRegistryStub["buildProjectsPayload"]>;
		buildWorkspaceStateSnapshot: Mock<WorkspaceRegistryStub["buildWorkspaceStateSnapshot"]>;
	};
	server: Server;
	port: number;
}

function createEmptyBoard(): RuntimeBoardData {
	return {
		columns: [],
		dependencies: [],
	};
}

function createWorkspaceState(): RuntimeWorkspaceStateResponse {
	return {
		repoPath: TEST_WORKSPACE_PATH,
		statePath: `${TEST_WORKSPACE_PATH}/.kanban`,
		vcs: "git",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: createEmptyBoard(),
		sessions: {},
		revision: 1,
	};
}

function createSessionSummary(input: {
	taskId: string;
	state: RuntimeTaskSessionState;
	latestTurnCheckpoint?: RuntimeTaskTurnCheckpoint | null;
}): RuntimeTaskSessionSummary {
	return {
		taskId: input.taskId,
		state: input.state,
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: input.latestTurnCheckpoint ?? null,
		previousTurnCheckpoint: null,
	};
}

function createTurnCheckpoint(turn: number, commit: string): RuntimeTaskTurnCheckpoint {
	return {
		turn,
		ref: `refs/kanban/checkpoints/${turn}`,
		commit,
		createdAt: Date.now(),
	};
}

function createWorkspaceRegistryMocks(overrides?: Partial<HubTestContext["workspaceRegistry"]>) {
	return {
		resolveWorkspaceForStream: vi.fn<WorkspaceRegistryStub["resolveWorkspaceForStream"]>(async () => ({
			workspaceId: TEST_WORKSPACE_ID,
			workspacePath: TEST_WORKSPACE_PATH,
			removedRequestedWorkspacePath: null,
			didPruneProjects: false,
		})),
		buildProjectsPayload: vi.fn<WorkspaceRegistryStub["buildProjectsPayload"]>(async (preferredCurrentProjectId) => ({
			currentProjectId: preferredCurrentProjectId,
			projects: [],
		})),
		buildWorkspaceStateSnapshot: vi.fn<WorkspaceRegistryStub["buildWorkspaceStateSnapshot"]>(async () =>
			createWorkspaceState(),
		),
		...overrides,
	};
}

function createFakeTerminalSessionManager(): {
	manager: TerminalSessionManager;
	emitSummary: (summary: RuntimeTaskSessionSummary) => void;
} {
	const summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	const manager = {
		onSummary: (listener: (summary: RuntimeTaskSessionSummary) => void) => {
			summaryListeners.add(listener);
			return () => {
				summaryListeners.delete(listener);
			};
		},
	} as unknown as TerminalSessionManager;
	return {
		manager,
		emitSummary: (summary) => {
			for (const listener of summaryListeners) {
				listener(summary);
			}
		},
	};
}

async function startHub(overrides?: Partial<HubTestContext["workspaceRegistry"]>): Promise<HubTestContext> {
	const warn = vi.fn<(message: string) => void>();
	const persistTaskSessionSummary = vi.fn<CreateRuntimeStateHubDependencies["persistTaskSessionSummary"]>(
		async () => {},
	);
	const workspaceRegistry = createWorkspaceRegistryMocks(overrides);
	const hub = createRuntimeStateHub({ workspaceRegistry, persistTaskSessionSummary, warn });
	const server = createServer();
	server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		hub.handleUpgrade(request, socket, head, { requestedWorkspaceId: TEST_WORKSPACE_ID });
	});
	await new Promise<void>((resolveListen) => {
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = server.address();
	if (typeof address !== "object" || !address) {
		throw new Error("Failed to bind the test server port.");
	}
	return { hub, warn, persistTaskSessionSummary, workspaceRegistry, server, port: address.port };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for condition.");
		}
		await delay(10);
	}
}

function delay(durationMs: number): Promise<void> {
	return new Promise((resolveDelay) => {
		setTimeout(resolveDelay, durationMs);
	});
}

async function connectClient(port: number): Promise<{ socket: WebSocket; messages: RuntimeStateStreamMessage[] }> {
	const messages: RuntimeStateStreamMessage[] = [];
	const socket = new WebSocket(`ws://127.0.0.1:${port}/api/runtime/ws`);
	socket.on("message", (raw) => {
		messages.push(JSON.parse(String(raw)) as RuntimeStateStreamMessage);
	});
	await new Promise<void>((resolveOpen, rejectOpen) => {
		socket.once("open", () => resolveOpen());
		socket.once("error", rejectOpen);
	});
	await waitForCondition(() => messages.some((message) => message.type === "snapshot"));
	return { socket, messages };
}

describe("runtime state hub", () => {
	const contexts: HubTestContext[] = [];
	const sockets: WebSocket[] = [];

	afterEach(async () => {
		for (const socket of sockets.splice(0)) {
			socket.terminate();
		}
		for (const context of contexts.splice(0)) {
			await context.hub.close();
			await new Promise<void>((resolveClose) => {
				context.server.close(() => resolveClose());
			});
		}
		vi.restoreAllMocks();
	});

	it("warns with context and rate-limits repeated projects broadcast failures", async () => {
		const context = await startHub({
			buildProjectsPayload: vi
				.fn<WorkspaceRegistryStub["buildProjectsPayload"]>()
				.mockResolvedValueOnce({ currentProjectId: TEST_WORKSPACE_ID, projects: [] })
				.mockRejectedValue(new Error("board read failed")),
		});
		contexts.push(context);
		const { socket } = await connectClient(context.port);
		sockets.push(socket);

		await context.hub.broadcastRuntimeProjectsUpdated(null);
		expect(context.warn).toHaveBeenCalledTimes(1);
		expect(context.warn.mock.calls[0]?.[0]).toContain("projects_updated_broadcast");
		expect(context.warn.mock.calls[0]?.[0]).toContain("board read failed");

		// Repeated failures inside the rate-limit window are counted, not logged.
		await context.hub.broadcastRuntimeProjectsUpdated(null);
		expect(context.warn).toHaveBeenCalledTimes(1);

		// After the window passes the next failure logs again with the suppressed count.
		const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
		try {
			await context.hub.broadcastRuntimeProjectsUpdated(null);
			expect(context.warn).toHaveBeenCalledTimes(2);
			expect(context.warn.mock.calls[1]?.[0]).toContain("suppressed 1 repeated failure");
		} finally {
			dateNowSpy.mockRestore();
		}
	});

	it("warns with workspace context when a workspace-state broadcast fails", async () => {
		const context = await startHub({
			buildWorkspaceStateSnapshot: vi
				.fn<WorkspaceRegistryStub["buildWorkspaceStateSnapshot"]>()
				.mockResolvedValueOnce(createWorkspaceState())
				.mockRejectedValue(new Error("state read failed")),
		});
		contexts.push(context);
		const { socket } = await connectClient(context.port);
		sockets.push(socket);

		await context.hub.broadcastRuntimeWorkspaceStateUpdated(TEST_WORKSPACE_ID, TEST_WORKSPACE_PATH);
		expect(context.warn).toHaveBeenCalledTimes(1);
		expect(context.warn.mock.calls[0]?.[0]).toContain("workspace_state_broadcast");
		expect(context.warn.mock.calls[0]?.[0]).toContain(TEST_WORKSPACE_ID);
		expect(context.warn.mock.calls[0]?.[0]).toContain("state read failed");
	});

	it("does not re-read boards or rebuild snapshots on a plain session tick", async () => {
		const context = await startHub();
		contexts.push(context);
		const { socket, messages } = await connectClient(context.port);
		sockets.push(socket);

		const fakeManager = createFakeTerminalSessionManager();
		context.hub.trackTerminalManager(TEST_WORKSPACE_ID, fakeManager.manager);
		fakeManager.emitSummary(createSessionSummary({ taskId: "task-1", state: "running" }));

		// Let the initial batched flush and the debounced projects broadcast settle.
		await waitForCondition(() => context.workspaceRegistry.buildProjectsPayload.mock.calls.length >= 2);
		const projectsBuildsAfterSettle = context.workspaceRegistry.buildProjectsPayload.mock.calls.length;
		const snapshotBuildsAfterSettle = context.workspaceRegistry.buildWorkspaceStateSnapshot.mock.calls.length;
		messages.length = 0;

		// Plain ticks: same count-relevant state, fresh timestamps.
		for (let index = 0; index < 3; index += 1) {
			fakeManager.emitSummary(createSessionSummary({ taskId: "task-1", state: "running" }));
			await delay(60);
		}
		await delay(900);

		expect(context.workspaceRegistry.buildProjectsPayload.mock.calls).toHaveLength(projectsBuildsAfterSettle);
		expect(context.workspaceRegistry.buildWorkspaceStateSnapshot.mock.calls).toHaveLength(snapshotBuildsAfterSettle);
		// Session deltas still stream to clients even though nothing is rebuilt.
		expect(messages.some((message) => message.type === "task_sessions_updated")).toBe(true);
	});

	it("persists emitted task summaries before shutdown completes", async () => {
		const context = await startHub();
		contexts.push(context);
		const fakeManager = createFakeTerminalSessionManager();
		context.hub.trackTerminalManager(TEST_WORKSPACE_ID, fakeManager.manager);
		const summary: RuntimeTaskSessionSummary = {
			...createSessionSummary({ taskId: "durable-task", state: "running" }),
			durableSessionName: "kanban.ws-1.codex.durable-task.0123456789ab",
		};
		let resolvePersistence: (() => void) | undefined;
		context.persistTaskSessionSummary.mockImplementationOnce(
			async () =>
				await new Promise<void>((resolve) => {
					resolvePersistence = resolve;
				}),
		);

		fakeManager.emitSummary(summary);
		let didClose = false;
		const closing = context.hub.close().then(() => {
			didClose = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(didClose).toBe(false);
		resolvePersistence?.();
		await closing;

		expect(context.persistTaskSessionSummary).toHaveBeenCalledWith(TEST_WORKSPACE_ID, summary);
		contexts.splice(contexts.indexOf(context), 1);
		await new Promise<void>((resolveClose) => {
			context.server.close(() => resolveClose());
		});
	});

	it("debounces project-count broadcasts when count-relevant session states change", async () => {
		const context = await startHub();
		contexts.push(context);
		const { socket } = await connectClient(context.port);
		sockets.push(socket);

		const fakeManager = createFakeTerminalSessionManager();
		context.hub.trackTerminalManager(TEST_WORKSPACE_ID, fakeManager.manager);
		fakeManager.emitSummary(createSessionSummary({ taskId: "task-1", state: "running" }));
		await waitForCondition(() => context.workspaceRegistry.buildProjectsPayload.mock.calls.length >= 2);
		const projectsBuildsAfterSettle = context.workspaceRegistry.buildProjectsPayload.mock.calls.length;

		// Two count-relevant changes inside one debounce window coalesce into one broadcast.
		fakeManager.emitSummary(createSessionSummary({ taskId: "task-1", state: "awaiting_review" }));
		await delay(250);
		fakeManager.emitSummary(createSessionSummary({ taskId: "task-1", state: "running" }));
		await delay(900);

		expect(context.workspaceRegistry.buildProjectsPayload.mock.calls).toHaveLength(projectsBuildsAfterSettle + 1);
	});

	it("streams checkpoint changes as deltas without rebuilding the workspace snapshot", async () => {
		const context = await startHub();
		contexts.push(context);
		const { socket, messages } = await connectClient(context.port);
		sockets.push(socket);

		const fakeManager = createFakeTerminalSessionManager();
		context.hub.trackTerminalManager(TEST_WORKSPACE_ID, fakeManager.manager);
		fakeManager.emitSummary(
			createSessionSummary({
				taskId: "task-1",
				state: "running",
				latestTurnCheckpoint: createTurnCheckpoint(1, "commit-a"),
			}),
		);
		await delay(300);
		const snapshotBuildsAfterSettle = context.workspaceRegistry.buildWorkspaceStateSnapshot.mock.calls.length;
		messages.length = 0;

		fakeManager.emitSummary(
			createSessionSummary({
				taskId: "task-1",
				state: "running",
				latestTurnCheckpoint: createTurnCheckpoint(2, "commit-b"),
			}),
		);
		await delay(500);

		expect(context.workspaceRegistry.buildWorkspaceStateSnapshot.mock.calls).toHaveLength(snapshotBuildsAfterSettle);
		expect(context.warn).not.toHaveBeenCalled();
		const sessionDelta = messages.find((message) => message.type === "task_sessions_updated");
		expect(sessionDelta).toBeDefined();
		if (sessionDelta?.type === "task_sessions_updated") {
			expect(sessionDelta.summaries[0]?.latestTurnCheckpoint?.commit).toBe("commit-b");
		}
	});
});
