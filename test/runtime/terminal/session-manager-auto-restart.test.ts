import { beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		wasDetached: vi.fn(() => false),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

describe("TerminalSessionManager auto-restart", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("restarts an attached agent session after it exits", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		spawnedSessions[0]?.triggerExit(130);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		});
		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(manager.getSummary("task-1")?.pid).toBe(222);
	});

	it("does not restart an attached agent session after an explicit stop", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		await manager.stopTaskSession("task-1");
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.pid).toBeNull();
	});

	it("transfers a shared session only to the newest serialized execution attempt", async () => {
		type PreparedLaunch = {
			binary: string | undefined;
			args: string[];
			env: Record<string, string>;
		};
		let resolveFirstLaunch: (launch: PreparedLaunch) => void = () => {
			throw new Error("First launch resolver was not initialized.");
		};
		const firstLaunch = new Promise<PreparedLaunch>((resolve) => {
			resolveFirstLaunch = resolve;
		});
		prepareAgentLaunchMock.mockImplementationOnce(async () => await firstLaunch);
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		const createRequest = (attemptId: string, queuedAt: number) => ({
			taskId: "task-1",
			agentId: "codex" as const,
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			executionAttempt: { attemptId, generation: 1, queuedAt },
		});

		const firstStart = manager.startTaskSession(createRequest("attempt-1", 10));
		await vi.waitFor(() => expect(prepareAgentLaunchMock).toHaveBeenCalledOnce());
		const secondStart = manager.startTaskSession(createRequest("attempt-2", 11));
		const staleStop = manager.stopTaskSession("task-1", "attempt-1");
		resolveFirstLaunch({ binary: "codex", args: [], env: {} });

		await expect(firstStart).resolves.toMatchObject({ state: "running" });
		await expect(secondStart).resolves.toMatchObject({ state: "running" });
		await expect(staleStop).resolves.toBeNull();
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
		await expect(manager.startTaskSession(createRequest("attempt-1", 10))).rejects.toThrow("cannot take ownership");

		await expect(manager.stopTaskSession("task-1", "attempt-2")).resolves.toMatchObject({ taskId: "task-1" });
		expect(spawnedSessions[0]?.stop).toHaveBeenCalledOnce();
	});

	it("does not let legacy unowned cleanup stop an admitted execution attempt", async () => {
		prepareAgentLaunchMock.mockResolvedValue({ binary: "codex", args: [], env: {} });
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			executionAttempt: { attemptId: "attempt-1", generation: 1, queuedAt: 10 },
		});

		await expect(manager.stopTaskSession("task-1", null)).resolves.toBeNull();
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
	});

	it("replaces a retired stale session without letting its delayed exit clear the newer attempt", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});
		const manager = new TerminalSessionManager();
		const createRequest = (attemptId: string, queuedAt: number) => ({
			taskId: "task-1",
			agentId: "codex" as const,
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			executionAttempt: { attemptId, generation: 1, queuedAt },
		});

		await manager.startTaskSession(createRequest("attempt-1", 10));
		const staleStop = manager.stopTaskSession("task-1", "attempt-1");
		const newerStart = manager.startTaskSession(createRequest("attempt-2", 11));

		await expect(staleStop).resolves.toMatchObject({ state: "awaiting_review" });
		await expect(newerStart).resolves.toMatchObject({ state: "running", pid: 222 });
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		spawnedSessions[0]?.triggerExit(0);
		expect(manager.getSummary("task-1")).toMatchObject({ state: "running", pid: 222 });
		expect(spawnedSessions[1]?.stop).not.toHaveBeenCalled();

		await manager.stopTaskSession("task-1", "attempt-2");
		await expect(manager.startTaskSession(createRequest("attempt-1", 10))).rejects.toThrow("cannot take ownership");
	});

	it("sends deferred Codex startup input when the prompt marker appears", async () => {
		const deferredStartupInput = "\u001b[200~/plan Validate rollout\u001b[201~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			startInPlanMode: true,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData("Booting Codex\n");
		expect(session.write).not.toHaveBeenCalledWith(deferredStartupInput);

		session.triggerData("› ");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});

	it("sends deferred Codex startup input when the startup UI header appears", async () => {
		const deferredStartupInput = "\u001b[200~/plan Validate startup UI detect\u001b[201~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
			startInPlanMode: true,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData(">_ OpenAI Codex (v0.117.0)\n");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});

	it.each(["grok", "kimi"] as const)("sends deferred %s input after its TUI starts rendering", async (agentId) => {
		const deferredStartupInput = `\u001b[200~Start ${agentId}\u001b[201~\r`;
		prepareAgentLaunchMock.mockResolvedValue({
			binary: agentId,
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: `task-${agentId}`,
			agentId,
			binary: agentId,
			args: [],
			cwd: `/tmp/task-${agentId}`,
			prompt: `Start ${agentId}`,
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData(`Starting ${agentId}\n`);
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});
});
