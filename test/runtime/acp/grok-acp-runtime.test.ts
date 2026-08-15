import type {
	InitializeResponse,
	LoadSessionResponse,
	NewSessionResponse,
	PromptResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { GrokAcpConnection } from "../../../src/acp/grok-acp-client";
import { GrokAcpRuntime } from "../../../src/acp/grok-acp-runtime";
import { type RuntimeTaskSessionSummary, runtimeGrokAcpConnectionIdentitySchema } from "../../../src/core/api-contract";

const initialized: InitializeResponse = {
	protocolVersion: 1,
	agentCapabilities: { loadSession: true },
	authMethods: [{ id: "xai.api_key", name: "xAI API key" }],
};

const created: NewSessionResponse = { sessionId: "session-1" };
const loaded: LoadSessionResponse = {};
const completed: PromptResponse = { stopReason: "end_turn" };

interface FakeConnection extends GrokAcpConnection {
	emit: (notification: SessionNotification) => void;
	disconnect: () => void;
	initialize: ReturnType<typeof vi.fn<GrokAcpConnection["initialize"]>>;
	loadSession: ReturnType<typeof vi.fn<GrokAcpConnection["loadSession"]>>;
	prompt: ReturnType<typeof vi.fn<GrokAcpConnection["prompt"]>>;
	cancel: ReturnType<typeof vi.fn<GrokAcpConnection["cancel"]>>;
	close: ReturnType<typeof vi.fn<GrokAcpConnection["close"]>>;
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createConnection(input?: {
	initialize?: () => Promise<InitializeResponse>;
	loadSession?: () => Promise<LoadSessionResponse>;
	prompt?: () => Promise<PromptResponse>;
}): FakeConnection {
	let onSessionUpdate: ((notification: SessionNotification) => void | Promise<void>) | null = null;
	let onClose: (() => void) | null = null;
	const connection: FakeConnection = {
		initialize: vi.fn(input?.initialize ?? (async () => initialized)),
		newSession: vi.fn(async () => created),
		loadSession: vi.fn(input?.loadSession ?? (async () => loaded)),
		prompt: vi.fn(input?.prompt ?? (async () => completed)),
		cancel: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
		emit: (notification) => {
			void onSessionUpdate?.(notification);
		},
		disconnect: () => onClose?.(),
	};
	Object.defineProperty(connection, "setCallbacks", {
		value: (callbacks: {
			onSessionUpdate: (notification: SessionNotification) => void | Promise<void>;
			onClose?: () => void;
		}) => {
			onSessionUpdate = callbacks.onSessionUpdate;
			onClose = callbacks.onClose ?? null;
		},
	});
	return connection;
}

function createConnect(connections: FakeConnection[]) {
	return vi.fn((_identity, callbacks) => {
		const connection = connections.shift();
		if (!connection) {
			throw new Error("Unexpected ACP connection.");
		}
		(connection as FakeConnection & { setCallbacks: (value: typeof callbacks) => void }).setCallbacks(callbacks);
		return connection;
	});
}

function createRuntime(
	connections: FakeConnection[],
	onSummary = vi.fn<(summary: RuntimeTaskSessionSummary) => void>(),
	liveSessionNames = ["kanban.workspace.grok.task.digest"],
) {
	const launch = vi.fn(async () => ({
		endpoint: "ws://127.0.0.1:2419/ws",
		port: 2419,
		pid: 123,
		zmxSessionName: "kanban.workspace.grok.task.digest",
	}));
	const deleteSecret = vi.fn(async () => undefined);
	const zmxControl = {
		listSessionNames: vi.fn(async () => liveSessionNames),
		killSession: vi.fn(async () => undefined),
	};
	return {
		runtime: new GrokAcpRuntime({
			connect: createConnect(connections),
			launch,
			createSecret: vi.fn(async () => ({ secret: "transport-secret", secretRef: "secret-ref" })),
			resolveSecret: vi.fn(async () => "transport-secret"),
			deleteSecret,
			zmxControl,
			onSummary,
			connectAttempts: 2,
			connectRetryMs: 0,
		}),
		onSummary,
		deleteSecret,
		launch,
		zmxControl,
	};
}

const startRequest = {
	taskId: "task-1",
	binary: "grok",
	cwd: "/tmp/workspace",
	prompt: "",
	resumeFromTrash: true,
	workspaceId: "workspace-1",
	executionAttempt: { attemptId: "attempt-1", generation: 1, queuedAt: 1 },
};

function persistedSummary(): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		mode: "act",
		agentId: "grok",
		workspacePath: "/tmp/workspace",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		durableSessionName: "kanban.workspace.grok.task.digest",
		acpConnection: {
			transport: "websocket",
			endpoint: "ws://127.0.0.1:2419/ws",
			zmxSessionName: "kanban.workspace.grok.task.digest",
			attemptId: "attempt-1",
			generation: 1,
			queuedAt: 1,
			sessionId: "session-1",
			secretRef: "secret-ref",
		},
		acpActivity: [],
		acpNextSequence: 1,
	};
}

describe("GrokAcpRuntime", () => {
	it("persists only an uncredentialed loopback ACP endpoint", () => {
		const identity = persistedSummary().acpConnection;
		if (!identity) throw new Error("Expected a persisted ACP identity fixture.");

		expect(runtimeGrokAcpConnectionIdentitySchema.safeParse(identity).success).toBe(true);
		expect(
			runtimeGrokAcpConnectionIdentitySchema.safeParse({ ...identity, endpoint: "wss://example.com/ws" }).success,
		).toBe(false);
		expect(
			runtimeGrokAcpConnectionIdentitySchema.safeParse({
				...identity,
				endpoint: "ws://transport-secret@127.0.0.1:2419/ws",
			}).success,
		).toBe(false);
	});

	it("creates a fresh ACP transport after the first startup initialize failure", async () => {
		const first = createConnection({ initialize: async () => Promise.reject(new Error("ECONNREFUSED")) });
		const second = createConnection();
		const { runtime } = createRuntime([first, second]);

		await expect(runtime.start(startRequest)).resolves.toMatchObject({ acpConnection: { sessionId: "session-1" } });
		expect(first.initialize).toHaveBeenCalledOnce();
		expect(first.close).toHaveBeenCalledOnce();
		expect(second.initialize).toHaveBeenCalledOnce();
	});

	it("sends task images as native ACP content blocks when the capability is negotiated", async () => {
		const connection = createConnection({
			initialize: async () => ({
				...initialized,
				agentCapabilities: { ...initialized.agentCapabilities, promptCapabilities: { image: true } },
			}),
		});
		const { runtime } = createRuntime([connection]);

		await runtime.start({
			...startRequest,
			prompt: "Inspect this diagram",
			resumeFromTrash: false,
			images: [{ id: "image-1", name: "diagram.png", mimeType: "image/png", data: "aGVsbG8=" }],
		});

		await vi.waitFor(() => expect(connection.prompt).toHaveBeenCalledOnce());
		expect(connection.prompt).toHaveBeenCalledWith({
			sessionId: "session-1",
			prompt: [
				expect.objectContaining({ type: "text", text: expect.stringContaining("Inspect this diagram") }),
				{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
			],
		});
	});

	it("coalesces concurrent starts for the same exact execution attempt", async () => {
		const initialize = deferred<InitializeResponse>();
		const connection = createConnection({ initialize: async () => await initialize.promise });
		const { runtime } = createRuntime([connection]);

		const first = runtime.start(startRequest);
		const second = runtime.start(startRequest);
		initialize.resolve(initialized);

		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(connection.initialize).toHaveBeenCalledOnce();
	});

	it("lets a newer attempt supersede an older attempt while ACP startup is pending", async () => {
		const initializeOld = deferred<InitializeResponse>();
		const oldConnection = createConnection({ initialize: async () => await initializeOld.promise });
		const newConnection = createConnection();
		const { runtime, launch, deleteSecret } = createRuntime([oldConnection, newConnection]);

		const oldStart = runtime.start(startRequest);
		await vi.waitFor(() => expect(oldConnection.initialize).toHaveBeenCalledOnce());
		const newStart = runtime.start({
			...startRequest,
			prompt: "new attempt",
			resumeFromTrash: false,
			executionAttempt: { attemptId: "attempt-2", generation: 1, queuedAt: 2 },
		});
		initializeOld.resolve(initialized);

		await expect(oldStart).rejects.toThrow(
			'Execution attempt "attempt-1" lost ownership of task "task-1" to newer attempt "attempt-2"',
		);
		await expect(newStart).resolves.toMatchObject({
			state: "running",
			acpConnection: { attemptId: "attempt-2", queuedAt: 2 },
		});
		expect(oldConnection.close).toHaveBeenCalledOnce();
		expect(deleteSecret).toHaveBeenCalledWith("secret-ref");
		expect(launch).toHaveBeenCalledTimes(2);
	});

	it("rejects a stale retry before it can kill the newer durable session", async () => {
		const summary = persistedSummary();
		if (!summary.acpConnection) throw new Error("Expected a persisted ACP identity fixture.");
		summary.acpConnection = {
			...summary.acpConnection,
			attemptId: "attempt-new",
			queuedAt: 20,
		};
		const { runtime, launch, zmxControl } = createRuntime([]);
		runtime.hydrate({ "task-1": summary });

		await expect(
			runtime.start({
				...startRequest,
				executionAttempt: { attemptId: "attempt-old", generation: 1, queuedAt: 10 },
			}),
		).rejects.toThrow('cannot take ownership of task "task-1" from newer attempt "attempt-new"');
		expect(zmxControl.listSessionNames).not.toHaveBeenCalled();
		expect(zmxControl.killSession).not.toHaveBeenCalled();
		expect(launch).not.toHaveBeenCalled();
	});

	it("lets a newer attempt take over an active ACP process and fences the old attempt afterward", async () => {
		const first = createConnection();
		const second = createConnection();
		const { runtime, launch, zmxControl, deleteSecret } = createRuntime([first, second]);
		await runtime.start(startRequest);

		await expect(
			runtime.start({
				...startRequest,
				prompt: "retry",
				resumeFromTrash: false,
				executionAttempt: { attemptId: "attempt-2", generation: 1, queuedAt: 2 },
			}),
		).resolves.toMatchObject({ acpConnection: { attemptId: "attempt-2", queuedAt: 2 } });

		expect(first.cancel).toHaveBeenCalledWith("session-1");
		expect(first.close).toHaveBeenCalledOnce();
		expect(zmxControl.killSession).toHaveBeenCalledWith("kanban.workspace.grok.task.digest");
		expect(deleteSecret).toHaveBeenCalledWith("secret-ref");
		expect(launch).toHaveBeenCalledTimes(2);
		await expect(runtime.start(startRequest)).rejects.toThrow(
			'cannot take ownership of task "task-1" from newer attempt "attempt-2"',
		);
	});

	it("retains the newer attempt fence and an honest failed summary when takeover startup fails", async () => {
		const active = createConnection();
		const failedFirst = createConnection({ initialize: async () => Promise.reject(new Error("not ready")) });
		const failedSecond = createConnection({
			initialize: async () => Promise.reject(new Error("provider auth failed")),
		});
		const { runtime } = createRuntime([active, failedFirst, failedSecond]);
		await runtime.start(startRequest);

		await expect(
			runtime.start({
				...startRequest,
				resumeFromTrash: false,
				executionAttempt: { attemptId: "attempt-2", generation: 1, queuedAt: 2 },
			}),
		).rejects.toThrow("provider auth failed");
		expect(runtime.getSummary("task-1")).toMatchObject({
			state: "failed",
			durableSessionName: null,
			warningMessage: "provider auth failed",
			acpConnection: { attemptId: "attempt-2", queuedAt: 2, sessionId: "pending" },
		});
		await expect(runtime.start(startRequest)).rejects.toThrow(
			'cannot take ownership of task "task-1" from newer attempt "attempt-2"',
		);
	});

	it("reconnects the exact persisted attempt instead of launching a duplicate ACP server", async () => {
		const connection = createConnection();
		const { runtime } = createRuntime([connection]);
		runtime.hydrate({ "task-1": persistedSummary() });

		await expect(runtime.start(startRequest)).resolves.toMatchObject({
			acpConnection: { attemptId: "attempt-1", sessionId: "session-1" },
		});
		expect(connection.loadSession).toHaveBeenCalledWith({ cwd: "/tmp/workspace", sessionId: "session-1" });
	});

	it("coalesces concurrent reconnects onto one authenticated ACP connection", async () => {
		const initialize = deferred<InitializeResponse>();
		const connection = createConnection({ initialize: async () => await initialize.promise });
		const { runtime } = createRuntime([connection]);
		runtime.hydrate({ "task-1": persistedSummary() });

		const first = runtime.reconnect("task-1");
		const second = runtime.reconnect("task-1");
		initialize.resolve(initialized);

		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(connection.initialize).toHaveBeenCalledOnce();
		expect(connection.loadSession).toHaveBeenCalledOnce();
	});

	it("reconnects persisted live ACP sessions during runtime reconciliation", async () => {
		const connection = createConnection();
		const { runtime } = createRuntime([connection]);
		runtime.hydrate({ "task-1": persistedSummary() });

		await runtime.reconcile();

		expect(connection.initialize).toHaveBeenCalledOnce();
		expect(connection.loadSession).toHaveBeenCalledWith({ cwd: "/tmp/workspace", sessionId: "session-1" });
		expect(runtime.getSummary("task-1")?.warningMessage).toBeNull();
	});

	it("stops rather than reconnecting a persisted ACP session fenced by a newer board attempt", async () => {
		const { runtime, deleteSecret, zmxControl } = createRuntime([]);
		runtime.hydrate(
			{ "task-1": persistedSummary() },
			{ "task-1": { attemptId: "attempt-2", generation: 1, queuedAt: 2 } },
		);

		await runtime.reconcile();

		expect(zmxControl.killSession).toHaveBeenCalledWith("kanban.workspace.grok.task.digest");
		expect(deleteSecret).toHaveBeenCalledWith("secret-ref");
		expect(runtime.getSummary("task-1")).toMatchObject({ state: "idle", durableSessionName: null });
		await expect(runtime.start(startRequest)).rejects.toThrow(
			'cannot take ownership of task "task-1" from newer attempt "attempt-2"',
		);
	});

	it("fences an in-flight reconnect before a newer attempt starts", async () => {
		const initializeOld = deferred<InitializeResponse>();
		const oldConnection = createConnection({ initialize: async () => await initializeOld.promise });
		const newConnection = createConnection();
		const { runtime } = createRuntime([oldConnection, newConnection]);
		runtime.hydrate({ "task-1": persistedSummary() });

		const reconnect = runtime.reconnect("task-1");
		await vi.waitFor(() => expect(oldConnection.initialize).toHaveBeenCalledOnce());
		const newStart = runtime.start({
			...startRequest,
			prompt: "new attempt",
			resumeFromTrash: false,
			executionAttempt: { attemptId: "attempt-2", generation: 1, queuedAt: 2 },
		});
		initializeOld.resolve(initialized);

		await expect(reconnect).rejects.toThrow(
			'Execution attempt "attempt-1" lost ownership of task "task-1" to newer attempt "attempt-2"',
		);
		await expect(newStart).resolves.toMatchObject({
			state: "running",
			acpConnection: { attemptId: "attempt-2", queuedAt: 2 },
		});
		expect(oldConnection.close).toHaveBeenCalledOnce();
	});

	it("fails closed when the exact persisted zmx session disappeared during restart", async () => {
		const { runtime } = createRuntime([], undefined, []);
		runtime.hydrate({ "task-1": persistedSummary() });

		await runtime.reconcile();

		expect(runtime.getSummary("task-1")).toMatchObject({
			state: "idle",
			durableSessionName: null,
			warningMessage: expect.stringContaining("exact persisted Grok ACP zmx session is not running"),
		});
	});

	it("loads the persisted conversation without sending an empty prompt when a stopped task resumes", async () => {
		const connection = createConnection();
		const { runtime } = createRuntime([connection], undefined, []);
		runtime.hydrate({ "task-1": persistedSummary() });

		await runtime.start({ ...startRequest, projectPath: "/tmp/project" });

		expect(connection.loadSession).toHaveBeenCalledWith({ cwd: "/tmp/workspace", sessionId: "session-1" });
		expect(connection.newSession).not.toHaveBeenCalled();
		expect(connection.prompt).not.toHaveBeenCalled();
	});

	it("retains the persisted conversation identity when a resume load fails", async () => {
		const connection = createConnection({ loadSession: async () => Promise.reject(new Error("load failed")) });
		const { runtime } = createRuntime([connection], undefined, []);
		runtime.hydrate({ "task-1": persistedSummary() });

		await expect(
			runtime.start({
				...startRequest,
				executionAttempt: { attemptId: "attempt-2", generation: 1, queuedAt: 2 },
			}),
		).rejects.toThrow("load failed");

		expect(runtime.getSummary("task-1")).toMatchObject({
			state: "failed",
			durableSessionName: null,
			acpConnection: { attemptId: "attempt-2", sessionId: "session-1" },
		});
	});

	it("closes the reconnect transport when session/load fails", async () => {
		const connection = createConnection({ loadSession: async () => Promise.reject(new Error("load failed")) });
		const { runtime } = createRuntime([connection]);
		runtime.hydrate({ "task-1": persistedSummary() });

		await expect(runtime.reconnect("task-1")).rejects.toThrow("load failed");
		expect(connection.close).toHaveBeenCalledOnce();
		expect(runtime.getSummary("task-1")).toMatchObject({
			state: "failed",
			reviewReason: "error",
			warningMessage: "load failed",
		});
	});

	it("ignores failure and activity from a disconnected connection after reconnect", async () => {
		const oldTurn = deferred<PromptResponse>();
		const first = createConnection({ prompt: async () => await oldTurn.promise });
		const second = createConnection();
		const { runtime } = createRuntime([first, second]);
		await runtime.start(startRequest);
		await runtime.sendPrompt("task-1", "old turn");

		first.disconnect();
		await runtime.reconnect("task-1");
		first.emit({
			sessionId: "session-1",
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stale" } },
		});
		oldTurn.reject(new Error("old connection failed"));
		await vi.waitFor(() => {
			expect(runtime.getSummary("task-1")).toMatchObject({ state: "awaiting_review", acpActivity: [] });
		});
	});

	it("removes the task-scoped transport secret after startup failure and explicit stop", async () => {
		const first = createConnection({ initialize: async () => Promise.reject(new Error("not ready")) });
		const second = createConnection({ initialize: async () => Promise.reject(new Error("auth failed")) });
		const failed = createRuntime([first, second]);

		await expect(failed.runtime.start(startRequest)).rejects.toThrow("auth failed");
		expect(failed.zmxControl.killSession).toHaveBeenCalledWith("kanban.workspace.grok.task.digest");
		expect(failed.deleteSecret).toHaveBeenCalledWith("secret-ref");

		const activeConnection = createConnection();
		const active = createRuntime([activeConnection]);
		await active.runtime.start(startRequest);
		await active.runtime.stop("task-1", "attempt-1");
		expect(activeConnection.cancel).toHaveBeenCalledWith("session-1");
		expect(active.zmxControl.killSession).toHaveBeenCalledWith("kanban.workspace.grok.task.digest");
		expect(active.deleteSecret).toHaveBeenCalledWith("secret-ref");
	});

	it("caps replay at 200 items without retaining tool raw secrets", async () => {
		const connection = createConnection();
		const { runtime } = createRuntime([connection]);
		await runtime.start(startRequest);
		for (let sequence = 1; sequence <= 205; sequence += 1) {
			connection.emit({
				sessionId: "session-1",
				update: {
					sessionUpdate: "tool_call",
					toolCallId: `tool-${sequence}`,
					title: `Tool ${sequence}`,
					status: "completed",
					rawInput: { apiKey: `secret-${sequence}` },
				},
			});
		}

		const summary = runtime.getSummary("task-1");
		expect(summary?.acpActivity).toHaveLength(200);
		expect(summary?.acpActivity?.[0]?.text).toBe("Tool 6");
		expect(JSON.stringify(summary?.acpActivity)).not.toContain("secret-");
	});

	it("preserves the runtime-owned turn checkpoint when later ACP activity arrives", async () => {
		const connection = createConnection();
		const { runtime } = createRuntime([connection]);
		await runtime.start(startRequest);
		const checkpoint = {
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 10,
		};

		runtime.applyTurnCheckpoint("task-1", checkpoint);
		connection.emit({
			sessionId: "session-1",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Still working" },
			},
		});

		expect(runtime.getSummary("task-1")?.latestTurnCheckpoint).toEqual(checkpoint);
	});

	it("rejects overlapping turns, records prompt failure, and allows a later prompt", async () => {
		const firstTurn = deferred<PromptResponse>();
		const connection = createConnection({ prompt: async () => await firstTurn.promise });
		const { runtime } = createRuntime([connection]);
		await runtime.start(startRequest);

		await runtime.sendPrompt("task-1", "first");
		await expect(runtime.sendPrompt("task-1", "overlap")).rejects.toThrow(
			"already has an active Grok ACP prompt turn",
		);
		firstTurn.reject(new Error("provider failed"));
		await vi.waitFor(() => {
			expect(runtime.getSummary("task-1")).toMatchObject({
				state: "failed",
				reviewReason: "error",
				warningMessage: "provider failed",
			});
		});

		connection.prompt.mockResolvedValue(completed);
		await expect(runtime.sendPrompt("task-1", "retry")).resolves.toMatchObject({ taskId: "task-1" });
	});
});
