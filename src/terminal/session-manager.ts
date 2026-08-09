// PTY-backed runtime for agent task sessions and the workspace shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, Gemini, and shell sessions.
import type {
	RuntimeTaskExecutionAttemptReference,
	RuntimeTaskHookActivity,
	RuntimeTaskImage,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
	RuntimeWorkerCommandLogEntry,
} from "../core/api-contract";
import {
	type AgentAdapterLaunchInput,
	type AgentOutputTransitionDetector,
	type AgentOutputTransitionInspectionPredicate,
	prepareAgentLaunch,
} from "./agent-session-adapters";
import {
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
	stopWorkspaceTrustTimers,
	WORKSPACE_TRUST_CONFIRM_DELAY_MS,
} from "./claude-workspace-trust";
import { hasCodexWorkspaceTrustPrompt, shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import { isBinaryAvailableOnPath } from "./command-discovery";
import { stripAnsi } from "./output-utils";
import { PtySession } from "./pty-session";
import { reduceSessionTransition, type SessionTransitionEvent } from "./session-state-machine";
import {
	createTerminalProtocolFilterState,
	disableOscColorQueryIntercept,
	filterTerminalProtocolOutput,
	type TerminalProtocolFilterState,
} from "./terminal-protocol-filter";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service";
import { TerminalStateMirror } from "./terminal-state-mirror";
import { type WorkerCommandAttempt, WorkerCommandLog } from "./worker-command-log";
import {
	buildZmxWorkspaceSessionPrefix,
	createZmxSessionControl,
	prepareZmxAgentSession,
	type ZmxSessionControl,
} from "./zmx-agent-session";

const MAX_WORKSPACE_TRUST_BUFFER_CHARS = 16_384;
const AUTO_RESTART_WINDOW_MS = 5_000;
const MAX_AUTO_RESTARTS_PER_WINDOW = 3;
// TUI apps (Codex, OpenCode) can query OSC 10/11 before the browser terminal is attached
// and ready to answer. We intercept those startup probes during early PTY output, synthesize
// foreground/background color replies, then disable the filter once a live terminal listener
// has attached.
const OSC_FOREGROUND_QUERY_REPLY = "\u001b]10;rgb:e6e6/eded/f3f3\u001b\\";
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

type RestartableSessionRequest =
	| { kind: "task"; request: StartTaskSessionRequest }
	| { kind: "shell"; request: StartShellSessionRequest };

interface ActiveProcessState {
	session: PtySession;
	durableSessionName: string | null;
	workspaceTrustBuffer: string | null;
	cols: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	deferredStartupInput: string | null;
	detectOutputTransition: AgentOutputTransitionDetector | null;
	shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | null;
	awaitingCodexPromptAfterEnter: boolean;
	autoConfirmedWorkspaceTrust: boolean;
	workspaceTrustConfirmTimer: NodeJS.Timeout | null;
}

interface SessionEntry {
	summary: RuntimeTaskSessionSummary;
	active: ActiveProcessState | null;
	executionAttempt: RuntimeTaskExecutionAttemptReference | null;
	latestExecutionAttempt: RuntimeTaskExecutionAttemptReference | null;
	terminalStateMirror: TerminalStateMirror | null;
	listenerIdCounter: number;
	listeners: Map<number, TerminalSessionListener>;
	restartRequest: RestartableSessionRequest | null;
	suppressAutoRestartOnExit: boolean;
	autoRestartTimestamps: number[];
	pendingAutoRestart: Promise<void> | null;
	pendingOperation: Promise<void>;
}

export interface StartTaskSessionRequest {
	taskId: string;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	cols?: number;
	rows?: number;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	projectPath?: string;
	executionAttempt?: RuntimeTaskExecutionAttemptReference;
}

export interface StartShellSessionRequest {
	taskId: string;
	cwd: string;
	cols?: number;
	rows?: number;
	binary: string;
	args?: string[];
	env?: Record<string, string | undefined>;
}

function now(): number {
	return Date.now();
}

function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
	};
}

function updateSummary(entry: SessionEntry, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	entry.summary = {
		...entry.summary,
		...patch,
		updatedAt: now(),
	};
	return entry.summary;
}

function isActiveState(state: RuntimeTaskSessionState): boolean {
	return state === "running" || state === "awaiting_review";
}

function cloneStartTaskSessionRequest(request: StartTaskSessionRequest): StartTaskSessionRequest {
	return {
		...request,
		args: [...request.args],
		images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
		env: request.env ? { ...request.env } : undefined,
		executionAttempt: request.executionAttempt ? { ...request.executionAttempt } : undefined,
	};
}

function cloneStartShellSessionRequest(request: StartShellSessionRequest): StartShellSessionRequest {
	return {
		...request,
		args: request.args ? [...request.args] : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function compareExecutionAttempts(
	candidate: RuntimeTaskExecutionAttemptReference,
	current: RuntimeTaskExecutionAttemptReference,
): number {
	if (candidate.generation !== current.generation) {
		return candidate.generation - current.generation;
	}
	return candidate.queuedAt - current.queuedAt;
}

function formatSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found. Install a supported agent CLI and select it in Settings.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function formatShellSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found on this system.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function buildTerminalEnvironment(
	...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
	return {
		...process.env,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "kanban",
	};
}

function hasCodexInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	return /(?:^|[\n\r])\s*›\s*/u.test(stripped);
}

function hasCodexStartupUiRendered(text: string): boolean {
	const stripped = stripAnsi(text).toLowerCase();
	return stripped.includes("openai codex (v");
}

export interface TerminalSessionManagerOptions {
	// Injectable so tests can stub zmx (an optional external binary). Defaults
	// to the real zmx CLI control surface.
	zmxControl?: ZmxSessionControl;
	workspaceId?: string;
	warn?: (message: string) => void;
}

export class TerminalSessionManager implements TerminalSessionService {
	private readonly entries = new Map<string, SessionEntry>();
	private readonly summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private readonly durableTaskIds = new Set<string>();
	private readonly workerCommandLog = new WorkerCommandLog();
	private readonly zmxControl: ZmxSessionControl;
	private readonly workspaceSessionPrefix: string | null;
	private readonly warn: (message: string) => void;

	constructor(options?: TerminalSessionManagerOptions) {
		this.zmxControl = options?.zmxControl ?? createZmxSessionControl();
		this.workspaceSessionPrefix = buildZmxWorkspaceSessionPrefix(options?.workspaceId ?? "");
		this.warn = options?.warn ?? ((message) => process.stderr.write(`[kanban] ${message}\n`));
	}

	private trySendDeferredStartupInput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (
			!entry ||
			!active ||
			(entry.summary.agentId !== "codex" && entry.summary.agentId !== "grok" && entry.summary.agentId !== "kimi")
		) {
			return false;
		}
		if (active.deferredStartupInput === null) {
			return false;
		}
		const trustPromptVisible =
			entry.summary.agentId === "codex" &&
			active.workspaceTrustBuffer !== null &&
			hasCodexWorkspaceTrustPrompt(active.workspaceTrustBuffer);
		if (trustPromptVisible) {
			return false;
		}
		const deferredInput = active.deferredStartupInput;
		active.deferredStartupInput = null;
		active.session.write(deferredInput);
		return true;
	}

	private hasLiveOutputListener(entry: SessionEntry): boolean {
		for (const listener of entry.listeners.values()) {
			if (listener.onOutput) {
				return true;
			}
		}
		return false;
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	hydrateFromRecord(
		record: Record<string, RuntimeTaskSessionSummary>,
		executionAttemptsByTaskId: Record<string, RuntimeTaskExecutionAttemptReference | undefined> = {},
	): void {
		for (const [taskId, summary] of Object.entries(record)) {
			const executionAttempt = executionAttemptsByTaskId[taskId] ?? null;
			this.entries.set(taskId, {
				summary: cloneSummary(summary),
				active: null,
				executionAttempt: executionAttempt ? { ...executionAttempt } : null,
				latestExecutionAttempt: executionAttempt ? { ...executionAttempt } : null,
				terminalStateMirror: null,
				listenerIdCounter: 1,
				listeners: new Map(),
				restartRequest: null,
				suppressAutoRestartOnExit: false,
				autoRestartTimestamps: [],
				pendingAutoRestart: null,
				pendingOperation: Promise.resolve(),
			});
			// Repopulate durable-session tracking from the persisted record so a
			// restarted runtime still knows this task is backed by a live zmx
			// session (shutdown guard, stale-session recovery, reattach).
			if (summary.durableSessionName) {
				this.durableTaskIds.add(taskId);
			} else {
				this.durableTaskIds.delete(taskId);
			}
		}
		// Reconcile against the real zmx daemon in the background: drop durable
		// markers for sessions that died while the runtime was down and reap
		// orphans. reconcileDurableSessions never rejects.
		if (this.durableTaskIds.size > 0 || this.workspaceSessionPrefix) {
			void this.reconcileDurableSessions();
		}
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		return entry ? cloneSummary(entry.summary) : null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.entries.values()).map((entry) => cloneSummary(entry.summary));
	}

	listWorkerCommandLog(): RuntimeWorkerCommandLogEntry[] {
		return this.workerCommandLog.list();
	}

	isDurableTaskSession(taskId: string): boolean {
		return this.durableTaskIds.has(taskId);
	}

	// Reconciles this manager's durable-session tracking against the live zmx
	// daemon (called automatically from hydrateFromRecord after a runtime
	// restart; also invoked directly by tests with a stubbed control).
	//
	// - A persisted durable session that is still present in `zmx list` stays
	//   marked durable, so it remains reattachable and protected by the
	//   shutdown guard.
	// - A persisted durable session missing from `zmx list` died while the
	//   runtime was down: the durable marker is cleared and an active-looking
	//   summary is reset to idle so it no longer masquerades as reattachable.
	// - DECISION: `kanban.*` zmx sessions belonging to this workspace that match
	//   no known task are killed automatically (with a logged warning) rather
	//   than left running. Orphaned sessions hold worktree directories open and
	//   consume resources with no UI surface to reach them; leaking them forever
	//   is worse than reaping them. The manager's workspace id scopes the prefix,
	//   so sessions owned by other kanban workspaces are never touched. Deriving
	//   a prefix from persisted sessions remains a fallback for callers that
	//   construct a manager without workspace context.
	//
	// This method never rejects; list/kill failures are logged as warnings.
	async reconcileDurableSessions(control?: ZmxSessionControl): Promise<void> {
		// KANBAN_DURABLE_AGENT_SESSIONS=0 fully disables durable sessions,
		// including any zmx interaction during reconciliation.
		if (process.env.KANBAN_DURABLE_AGENT_SESSIONS === "0") {
			return;
		}
		const zmx = control ?? (isBinaryAvailableOnPath("zmx") ? this.zmxControl : null);
		if (!zmx) {
			return;
		}

		let sessionNames: string[];
		try {
			sessionNames = await zmx.listSessionNames();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.warn(`Could not list zmx sessions for durable-session reconciliation. ${message}`);
			return;
		}
		const liveSessionNames = new Set(sessionNames);

		const workspacePrefixes = new Set<string>();
		if (this.workspaceSessionPrefix) {
			workspacePrefixes.add(this.workspaceSessionPrefix);
		}
		for (const taskId of this.durableTaskIds) {
			const summary = this.entries.get(taskId)?.summary;
			if (!summary?.durableSessionName || !summary.agentId) {
				continue;
			}
			const agentMarker = `.${summary.agentId}.`;
			const markerIndex = summary.durableSessionName.indexOf(agentMarker);
			if (markerIndex > 0) {
				workspacePrefixes.add(summary.durableSessionName.slice(0, markerIndex + 1));
			}
		}

		for (const taskId of Array.from(this.durableTaskIds)) {
			const entry = this.entries.get(taskId);
			const sessionName = entry?.summary.durableSessionName;
			if (!entry || !sessionName || liveSessionNames.has(sessionName)) {
				continue;
			}
			this.durableTaskIds.delete(taskId);
			const patch: Partial<RuntimeTaskSessionSummary> = {
				durableSessionName: null,
				pid: null,
			};
			if (isActiveState(entry.summary.state)) {
				// The zmx session died while the runtime was down: surface the task
				// as idle instead of leaving a stale "running" summary that cannot
				// be reattached. Preserve agentId for trash-restore routing.
				Object.assign(patch, {
					state: "idle",
					startedAt: null,
					lastOutputAt: null,
					reviewReason: null,
				});
			}
			const summary = updateSummary(entry, patch);
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}

		const knownSessionNames = new Set<string>();
		for (const taskId of this.durableTaskIds) {
			const sessionName = this.entries.get(taskId)?.summary.durableSessionName;
			if (sessionName) {
				knownSessionNames.add(sessionName);
			}
		}
		for (const sessionName of sessionNames) {
			if (!sessionName.startsWith("kanban.") || knownSessionNames.has(sessionName)) {
				continue;
			}
			if (!Array.from(workspacePrefixes).some((prefix) => sessionName.startsWith(prefix))) {
				continue;
			}
			try {
				await zmx.killSession(sessionName);
				this.warn(`Killed orphaned durable zmx session "${sessionName}" (no matching kanban task).`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.warn(`Could not kill orphaned durable zmx session "${sessionName}". ${message}`);
			}
		}
	}

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const entry = this.ensureEntry(taskId);

		listener.onState?.(cloneSummary(entry.summary));
		if (entry.active && listener.onOutput) {
			disableOscColorQueryIntercept(entry.active.terminalProtocolFilter);
		}

		const listenerId = entry.listenerIdCounter;
		entry.listenerIdCounter += 1;
		entry.listeners.set(listenerId, listener);

		return () => {
			entry.listeners.delete(listenerId);
		};
	}

	async getRestoreSnapshot(taskId: string) {
		const entry = this.entries.get(taskId);
		if (!entry?.terminalStateMirror) {
			return null;
		}
		return await entry.terminalStateMirror.getSnapshot();
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		return await this.runEntryOperation(entry, async () => await this.startTaskSessionForEntry(entry, request));
	}

	private async startTaskSessionForEntry(
		entry: SessionEntry,
		request: StartTaskSessionRequest,
	): Promise<RuntimeTaskSessionSummary> {
		const requestedAttempt = request.executionAttempt;
		const latestAttempt = entry.latestExecutionAttempt;
		if (requestedAttempt && latestAttempt) {
			const order = compareExecutionAttempts(requestedAttempt, latestAttempt);
			if (order < 0 || (order === 0 && requestedAttempt.attemptId !== latestAttempt.attemptId)) {
				throw new Error(
					`Execution attempt "${requestedAttempt.attemptId}" cannot take ownership of task "${request.taskId}" from newer attempt "${latestAttempt.attemptId}".`,
				);
			}
		}
		if (requestedAttempt) {
			entry.latestExecutionAttempt = { ...requestedAttempt };
		}
		if (entry.active && isActiveState(entry.summary.state)) {
			if (requestedAttempt) {
				entry.executionAttempt = { ...requestedAttempt };
			}
			entry.restartRequest = {
				kind: "task",
				request: cloneStartTaskSessionRequest(request),
			};
			return cloneSummary(entry.summary);
		}

		entry.restartRequest = {
			kind: "task",
			request: cloneStartTaskSessionRequest(request),
		};

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});

		const launch = await prepareAgentLaunch({
			taskId: request.taskId,
			agentId: request.agentId,
			binary: request.binary,
			args: request.args,
			autonomousModeEnabled: request.autonomousModeEnabled,
			cwd: request.cwd,
			prompt: request.prompt,
			images: request.images,
			startInPlanMode: request.startInPlanMode,
			resumeFromTrash: request.resumeFromTrash,
			env: request.env,
			workspaceId: request.workspaceId,
			projectPath: request.projectPath,
		});

		const env = buildTerminalEnvironment(request.env, launch.env);

		// Adapters can wrap the configured agent binary when they need extra runtime wiring
		// (for example, Codex uses a wrapper script to watch session logs for hook transitions).
		const commandBinary = launch.binary ?? request.binary;
		const commandArgs = [...launch.args];
		// Durable zmx sessions keep the agent alive across runtime restarts.
		// Set KANBAN_DURABLE_AGENT_SESSIONS=0 to opt out entirely: agents then
		// launch directly on the PTY and are interrupted on shutdown, and
		// startup reconciliation leaves zmx untouched.
		const zmxLaunch =
			process.env.KANBAN_DURABLE_AGENT_SESSIONS === "0"
				? null
				: prepareZmxAgentSession({
						agentId: request.agentId,
						binary: commandBinary,
						args: commandArgs,
						taskId: request.taskId,
						workspaceId: request.workspaceId,
						zmxAvailable: isBinaryAvailableOnPath("zmx"),
					});
		if (zmxLaunch) {
			// The Kanban runtime may itself live inside a durable zmx holder.
			// A worker holder must start as a sibling, never inherit that parent
			// session identity and become a nested attach to the runtime shell.
			delete env.ZMX_SESSION;
		}
		const spawnBinary = zmxLaunch?.binary ?? commandBinary;
		const spawnArgs = zmxLaunch?.args ?? commandArgs;
		const commandAttempt: WorkerCommandAttempt = {
			taskId: request.taskId,
			agentId: request.agentId,
			cwd: request.cwd,
			binary: spawnBinary,
			args: spawnArgs,
			prompt: request.prompt,
			startedAt: now(),
		};
		const hasCodexLaunchSignature = [commandBinary, ...commandArgs].some((part) =>
			part.toLowerCase().includes("codex"),
		);
		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: spawnBinary,
				args: spawnArgs,
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					if (!entry.active || entry.active.session !== session) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
						onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
						onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}
					entry.terminalStateMirror?.applyOutput(filteredChunk);

					const needsDecodedOutput =
						entry.active.workspaceTrustBuffer !== null ||
						entry.active.deferredStartupInput !== null ||
						(entry.active.detectOutputTransition !== null &&
							(entry.active.shouldInspectOutputForTransition?.(entry.summary) ?? true));
					const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += data;
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
						if (!entry.active.autoConfirmedWorkspaceTrust && entry.active.workspaceTrustConfirmTimer === null) {
							const hasClaudePrompt = hasClaudeWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
							const hasCodexPrompt = hasCodexWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
							if (hasClaudePrompt || hasCodexPrompt) {
								entry.active.autoConfirmedWorkspaceTrust = true;
								const trustConfirmDelayMs = WORKSPACE_TRUST_CONFIRM_DELAY_MS;
								entry.active.workspaceTrustConfirmTimer = setTimeout(() => {
									const activeEntry = this.entries.get(request.taskId)?.active;
									if (!activeEntry || !activeEntry.autoConfirmedWorkspaceTrust) {
										return;
									}
									activeEntry.session.write("\r");
									// Trust text can remain in the rolling buffer after we auto-confirm.
									// Clear it so later startup/prompt checks do not match stale trust output.
									if (activeEntry.workspaceTrustBuffer !== null) {
										activeEntry.workspaceTrustBuffer = "";
									}
									activeEntry.workspaceTrustConfirmTimer = null;
								}, trustConfirmDelayMs);
							}
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					// Plan-mode startup input is deferred until the interactive TUI starts rendering.
					if (
						entry.active.deferredStartupInput !== null &&
						data.length > 0 &&
						(entry.summary.agentId === "grok" ||
							entry.summary.agentId === "kimi" ||
							(entry.summary.agentId === "codex" &&
								(hasCodexInteractivePrompt(data) ||
									hasCodexStartupUiRendered(data) ||
									(entry.active.workspaceTrustBuffer !== null &&
										(hasCodexInteractivePrompt(entry.active.workspaceTrustBuffer) ||
											hasCodexStartupUiRendered(entry.active.workspaceTrustBuffer))))))
					) {
						this.trySendDeferredStartupInput(request.taskId);
					}

					const adapterEvent = entry.active.detectOutputTransition?.(data, entry.summary) ?? null;
					if (adapterEvent) {
						const requiresEnterForCodex =
							adapterEvent.type === "agent.prompt-ready" &&
							entry.summary.agentId === "codex" &&
							!entry.active.awaitingCodexPromptAfterEnter;
						if (!requiresEnterForCodex) {
							const summary = this.applySessionEvent(entry, adapterEvent);
							if (adapterEvent.type === "agent.prompt-ready" && entry.summary.agentId === "codex") {
								entry.active.awaitingCodexPromptAfterEnter = false;
							}
							for (const taskListener of entry.listeners.values()) {
								taskListener.onState?.(cloneSummary(summary));
							}
							this.emitSummary(summary);
						}
					}

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive || currentActive.session !== session) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);
					if (currentActive.session.wasDetached()) {
						currentEntry.active = null;
						return;
					}
					this.durableTaskIds.delete(request.taskId);
					if (currentActive.durableSessionName) {
						// The zmx session itself exited: the durable marker must not
						// survive into the persisted record.
						updateSummary(currentEntry, { durableSessionName: null });
					}

					const summary = this.applySessionEvent(currentEntry, {
						type: "process.exit",
						exitCode: event.exitCode,
						interrupted: currentActive.session.wasInterrupted(),
					});
					const shouldAutoRestart = this.shouldAutoRestart(currentEntry);

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
					if (shouldAutoRestart) {
						this.scheduleAutoRestart(currentEntry);
					}

					const cleanupFn = currentActive.onSessionCleanup;
					currentActive.onSessionCleanup = null;
					if (cleanupFn) {
						cleanupFn().catch(() => {
							// Best effort: cleanup failure is non-critical.
						});
					}
				},
			});
		} catch (error) {
			this.workerCommandLog.record(commandAttempt, {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
			if (launch.cleanup) {
				void launch.cleanup().catch(() => {
					// Best effort: cleanup failure is non-critical.
				});
			}
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				state: "failed",
				agentId: request.agentId,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			entry.executionAttempt = null;
			throw new Error(formatSpawnFailure(spawnBinary, error));
		}

		const active: ActiveProcessState = {
			session,
			durableSessionName: zmxLaunch?.sessionName ?? null,
			workspaceTrustBuffer:
				shouldAutoConfirmClaudeWorkspaceTrust(request.agentId, request.cwd) ||
				shouldAutoConfirmCodexWorkspaceTrust(request.agentId, request.cwd) ||
				hasCodexLaunchSignature
					? ""
					: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
				suppressDeviceAttributeQueries: request.agentId === "droid",
			}),
			onSessionCleanup: launch.cleanup ?? null,
			deferredStartupInput: launch.deferredStartupInput ?? null,
			detectOutputTransition: launch.detectOutputTransition ?? null,
			shouldInspectOutputForTransition: launch.shouldInspectOutputForTransition ?? null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
		};
		if (active.durableSessionName) {
			this.durableTaskIds.add(request.taskId);
		} else {
			this.durableTaskIds.delete(request.taskId);
		}
		entry.active = active;
		entry.executionAttempt = request.executionAttempt ? { ...request.executionAttempt } : null;
		entry.terminalStateMirror = terminalStateMirror;
		this.workerCommandLog.record(commandAttempt, { status: "started", pid: session.pid });

		const startedAt = now();
		updateSummary(entry, {
			state: request.resumeFromTrash ? "awaiting_review" : "running",
			agentId: request.agentId,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt,
			lastOutputAt: null,
			reviewReason: request.resumeFromTrash ? "attention" : null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
			// Persisted so a restarted runtime can rehydrate durable-session
			// tracking (see hydrateFromRecord / reconcileDurableSessions).
			durableSessionName: active.durableSessionName,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "shell",
			request: cloneStartShellSessionRequest(request),
		};
		if (entry.active && entry.summary.state === "running") {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});
		const env = buildTerminalEnvironment(request.env);

		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: request.binary,
				args: request.args ?? [],
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					if (!entry.active) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
						onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
						onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}
					entry.terminalStateMirror?.applyOutput(filteredChunk);

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += filteredChunk.toString("utf8");
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);

					const summary = updateSummary(currentEntry, {
						state: currentActive.session.wasInterrupted() ? "interrupted" : "idle",
						reviewReason: currentActive.session.wasInterrupted() ? "interrupted" : null,
						exitCode: event.exitCode,
						pid: null,
					});

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
				},
			});
		} catch (error) {
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				state: "failed",
				agentId: null,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatShellSpawnFailure(request.binary, error));
		}

		const active: ActiveProcessState = {
			session,
			durableSessionName: null,
			workspaceTrustBuffer: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
			}),
			onSessionCleanup: null,
			deferredStartupInput: null,
			detectOutputTransition: null,
			shouldInspectOutputForTransition: null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;

		updateSummary(entry, {
			state: "running",
			agentId: null,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt: now(),
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (entry.active || !isActiveState(entry.summary.state)) {
			return cloneSummary(entry.summary);
		}

		if (this.durableTaskIds.has(taskId) && entry.summary.durableSessionName) {
			// Detached but alive: the durable zmx session survived the runtime
			// restart (hydrateFromRecord + reconcileDurableSessions verified it).
			// Keep the active state so the task surfaces as reattachable instead
			// of silently flipping to idle; startTaskSession reattaches to the
			// live zmx session by name. Only the recorded pid is stale — it
			// belonged to the previous runtime's zmx attach client.
			const summary = updateSummary(entry, { pid: null });
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
			return cloneSummary(summary);
		}

		// Preserve agentId so the server can resume the task with the same
		// agent runtime when it is restored from trash.
		const summary = updateSummary(entry, {
			state: "idle",
			workspacePath: null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});

		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return null;
		}
		if (
			entry.summary.agentId === "codex" &&
			entry.summary.state === "awaiting_review" &&
			(entry.summary.reviewReason === "hook" ||
				entry.summary.reviewReason === "attention" ||
				entry.summary.reviewReason === "error") &&
			(data.includes(13) || data.includes(10))
		) {
			entry.active.awaitingCodexPromptAfterEnter = true;
		}
		entry.active.session.write(data);
		return cloneSummary(entry.summary);
	}

	resize(taskId: string, cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		const safeCols = Math.max(1, Math.floor(cols));
		const safeRows = Math.max(1, Math.floor(rows));
		const safePixelWidth = Number.isFinite(pixelWidth ?? Number.NaN) ? Math.floor(pixelWidth as number) : undefined;
		const safePixelHeight = Number.isFinite(pixelHeight ?? Number.NaN)
			? Math.floor(pixelHeight as number)
			: undefined;
		const normalizedPixelWidth = safePixelWidth !== undefined && safePixelWidth > 0 ? safePixelWidth : undefined;
		const normalizedPixelHeight = safePixelHeight !== undefined && safePixelHeight > 0 ? safePixelHeight : undefined;
		entry.active.session.resize(safeCols, safeRows, normalizedPixelWidth, normalizedPixelHeight);
		entry.terminalStateMirror?.resize(safeCols, safeRows);
		entry.active.cols = safeCols;
		entry.active.rows = safeRows;
		return true;
	}

	pauseOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.pause();
		return true;
	}

	resumeOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.resume();
		return true;
	}

	transitionToReview(taskId: string, reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (reason !== "hook") {
			return cloneSummary(entry.summary);
		}
		const before = entry.summary;
		const summary = this.applySessionEvent(entry, { type: "hook.to_review" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	applyHookActivity(taskId: string, activity: Partial<RuntimeTaskHookActivity>): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const hasActivityUpdate =
			typeof activity.activityText === "string" ||
			typeof activity.toolName === "string" ||
			typeof activity.toolInputSummary === "string" ||
			typeof activity.finalMessage === "string" ||
			typeof activity.hookEventName === "string" ||
			typeof activity.notificationType === "string" ||
			typeof activity.source === "string";
		if (!hasActivityUpdate) {
			return cloneSummary(entry.summary);
		}

		const previous = entry.summary.latestHookActivity;
		const next: RuntimeTaskHookActivity = {
			activityText:
				typeof activity.activityText === "string" ? activity.activityText : (previous?.activityText ?? null),
			toolName: typeof activity.toolName === "string" ? activity.toolName : (previous?.toolName ?? null),
			toolInputSummary:
				typeof activity.toolInputSummary === "string"
					? activity.toolInputSummary
					: (previous?.toolInputSummary ?? null),
			finalMessage:
				typeof activity.finalMessage === "string" ? activity.finalMessage : (previous?.finalMessage ?? null),
			hookEventName:
				typeof activity.hookEventName === "string" ? activity.hookEventName : (previous?.hookEventName ?? null),
			notificationType:
				typeof activity.notificationType === "string"
					? activity.notificationType
					: (previous?.notificationType ?? null),
			source: typeof activity.source === "string" ? activity.source : (previous?.source ?? null),
		};

		const didChange =
			next.activityText !== (previous?.activityText ?? null) ||
			next.toolName !== (previous?.toolName ?? null) ||
			next.toolInputSummary !== (previous?.toolInputSummary ?? null) ||
			next.finalMessage !== (previous?.finalMessage ?? null) ||
			next.hookEventName !== (previous?.hookEventName ?? null) ||
			next.notificationType !== (previous?.notificationType ?? null) ||
			next.source !== (previous?.source ?? null);
		if (!didChange) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			lastHookAt: now(),
			latestHookActivity: next,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	transitionToRunning(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const before = entry.summary;
		const summary = this.applySessionEvent(entry, { type: "hook.to_in_progress" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const latestCheckpoint = entry.summary.latestTurnCheckpoint ?? null;
		if (latestCheckpoint?.ref === checkpoint.ref && latestCheckpoint.commit === checkpoint.commit) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			previousTurnCheckpoint: latestCheckpoint,
			latestTurnCheckpoint: checkpoint,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	async stopTaskSession(
		taskId: string,
		executionAttemptId?: string | null,
	): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		return await this.runEntryOperation(
			entry,
			async () => await this.stopTaskSessionForEntry(entry, taskId, executionAttemptId),
		);
	}

	private async stopTaskSessionForEntry(
		entry: SessionEntry,
		taskId: string,
		executionAttemptId?: string | null,
	): Promise<RuntimeTaskSessionSummary | null> {
		if (executionAttemptId !== undefined && (entry.executionAttempt?.attemptId ?? null) !== executionAttemptId) {
			return null;
		}
		const active = entry.active;
		const cleanupFn = active?.onSessionCleanup ?? null;
		const previousSuppressAutoRestart = entry.suppressAutoRestartOnExit;
		entry.suppressAutoRestartOnExit = true;
		if (active) {
			active.onSessionCleanup = null;
			stopWorkspaceTrustTimers(active);
		}
		const sessionName = active?.durableSessionName ?? entry.summary.durableSessionName;
		if (sessionName) {
			try {
				await this.zmxControl.killSession(sessionName);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				this.warn(`Could not kill durable zmx session "${sessionName}" for task "${taskId}". ${message}`);
				entry.suppressAutoRestartOnExit = previousSuppressAutoRestart;
				if (active) {
					active.onSessionCleanup = cleanupFn;
				}
				throw error;
			}
			updateSummary(entry, { durableSessionName: null });
		}
		this.durableTaskIds.delete(taskId);
		entry.executionAttempt = null;
		let summary = entry.summary;
		if (active) {
			entry.active = null;
			active.session.stop();
			summary = this.applySessionEvent(entry, {
				type: "process.exit",
				exitCode: 0,
				interrupted: false,
			});
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
				listener.onExit?.(0);
			}
		}
		entry.suppressAutoRestartOnExit = previousSuppressAutoRestart;
		if (cleanupFn) {
			cleanupFn().catch(() => {
				// Best effort: cleanup failure is non-critical.
			});
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		const activeEntries = Array.from(this.entries.values()).filter((entry) => entry.active != null);
		const interruptedEntries: SessionEntry[] = [];
		for (const entry of activeEntries) {
			if (!entry.active) {
				continue;
			}
			stopWorkspaceTrustTimers(entry.active);
			if (entry.active.durableSessionName) {
				entry.active.session.detach();
				continue;
			}
			interruptedEntries.push(entry);
			entry.active.session.stop({ interrupted: true });
		}
		return interruptedEntries.map((entry) => cloneSummary(entry.summary));
	}

	private applySessionEvent(entry: SessionEntry, event: SessionTransitionEvent): RuntimeTaskSessionSummary {
		const transition = reduceSessionTransition(entry.summary, event);
		if (!transition.changed) {
			return entry.summary;
		}
		if (transition.clearAttentionBuffer && entry.active) {
			if (entry.active.workspaceTrustBuffer !== null) {
				entry.active.workspaceTrustBuffer = "";
			}
		}
		if (entry.active && transition.changed && transition.patch.state === "awaiting_review") {
			entry.active.awaitingCodexPromptAfterEnter = false;
		}
		return updateSummary(entry, transition.patch);
	}

	private ensureEntry(taskId: string): SessionEntry {
		const existing = this.entries.get(taskId);
		if (existing) {
			return existing;
		}
		const created: SessionEntry = {
			summary: createDefaultSummary(taskId),
			active: null,
			executionAttempt: null,
			latestExecutionAttempt: null,
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
			pendingOperation: Promise.resolve(),
		};
		this.entries.set(taskId, created);
		return created;
	}

	private async runEntryOperation<T>(entry: SessionEntry, operation: () => Promise<T>): Promise<T> {
		const queued = (entry.pendingOperation ?? Promise.resolve()).then(operation, operation);
		entry.pendingOperation = queued.then(
			() => undefined,
			() => undefined,
		);
		return await queued;
	}

	private shouldAutoRestart(entry: SessionEntry): boolean {
		const wasSuppressed = entry.suppressAutoRestartOnExit;
		entry.suppressAutoRestartOnExit = false;
		if (wasSuppressed) {
			return false;
		}
		if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
			return false;
		}
		const currentTime = now();
		entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
			(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
		);
		if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
			return false;
		}
		entry.autoRestartTimestamps.push(currentTime);
		return true;
	}

	private scheduleAutoRestart(entry: SessionEntry): void {
		if (entry.pendingAutoRestart) {
			return;
		}
		const restartRequest = entry.restartRequest;
		if (!restartRequest || restartRequest.kind !== "task") {
			return;
		}
		let pendingAutoRestart: Promise<void> | null = null;
		pendingAutoRestart = (async () => {
			try {
				await this.startTaskSession(cloneStartTaskSessionRequest(restartRequest.request));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const summary = updateSummary(entry, {
					warningMessage: message,
				});
				const output = Buffer.from(`\r\n[kanban] ${message}\r\n`, "utf8");
				for (const listener of entry.listeners.values()) {
					listener.onOutput?.(output);
					listener.onState?.(cloneSummary(summary));
				}
				this.emitSummary(summary);
			} finally {
				if (entry.pendingAutoRestart === pendingAutoRestart) {
					entry.pendingAutoRestart = null;
				}
			}
		})();
		entry.pendingAutoRestart = pendingAutoRestart;
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		const snapshot = cloneSummary(summary);
		for (const listener of this.summaryListeners) {
			listener(snapshot);
		}
	}
}
