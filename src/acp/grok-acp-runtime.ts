import type { ContentBlock, InitializeResponse, SessionNotification } from "@agentclientprotocol/sdk";

import type {
	RuntimeAcpActivityItem,
	RuntimeGrokAcpConnectionIdentity,
	RuntimeTaskDeliverableKind,
	RuntimeTaskExecutionAttemptReference,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { prepareAgentPrompt } from "../terminal/agent-session-adapters";
import type { ZmxSessionControl } from "../terminal/zmx-agent-session";
import { createZmxSessionControl } from "../terminal/zmx-agent-session";
import { toRuntimeAcpActivity } from "./grok-acp-activity";
import { createGrokAcpConnection, type GrokAcpConnection } from "./grok-acp-client";
import { launchGrokAcpServer } from "./grok-acp-process";
import { createGrokAcpSecret, deleteGrokAcpSecret, resolveGrokAcpSecret } from "./grok-acp-secret-store";

const CONNECT_ATTEMPTS = 40;
const CONNECT_RETRY_MS = 125;
const RECONNECT_ATTEMPTS = 5;
const MAX_REPLAY_ITEMS = 200;

export interface StartGrokAcpSessionRequest {
	taskId: string;
	binary: string;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	env?: Record<string, string | undefined>;
	workspaceId: string;
	projectPath?: string;
	deliverableKind?: RuntimeTaskDeliverableKind;
	executionAttempt: RuntimeTaskExecutionAttemptReference;
}

interface ActiveGrokAcpSession {
	connection: GrokAcpConnection;
	identity: RuntimeGrokAcpConnectionIdentity;
	promptPromise: Promise<void> | null;
}

interface PendingGrokAcpStart {
	executionAttempt: RuntimeTaskExecutionAttemptReference;
	promise: Promise<RuntimeTaskSessionSummary>;
}

export interface GrokAcpRuntimeOptions {
	onActivity?: (taskId: string, activity: RuntimeAcpActivityItem) => void;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	warn?: (message: string) => void;
	zmxControl?: ZmxSessionControl;
	connect?: typeof createGrokAcpConnection;
	launch?: typeof launchGrokAcpServer;
	createSecret?: typeof createGrokAcpSecret;
	resolveSecret?: typeof resolveGrokAcpSecret;
	deleteSecret?: typeof deleteGrokAcpSecret;
	connectAttempts?: number;
	connectRetryMs?: number;
}

function delay(durationMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function now(): number {
	return Date.now();
}

function compareExecutionAttempts(
	left: Pick<RuntimeTaskExecutionAttemptReference, "generation" | "queuedAt">,
	right: Pick<RuntimeTaskExecutionAttemptReference, "generation" | "queuedAt">,
): number {
	if (left.generation !== right.generation) {
		return left.generation - right.generation;
	}
	return left.queuedAt - right.queuedAt;
}

function isSameExecutionAttempt(
	left: RuntimeTaskExecutionAttemptReference,
	right: RuntimeTaskExecutionAttemptReference,
): boolean {
	return (
		left.attemptId === right.attemptId && left.generation === right.generation && left.queuedAt === right.queuedAt
	);
}

function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
		acpConnection: summary.acpConnection ? { ...summary.acpConnection } : undefined,
		acpActivity: summary.acpActivity?.map((item) => ({
			...item,
			plan: item.plan?.map((entry) => ({ ...entry })),
		})),
	};
}

function assertCapabilities(initialized: InitializeResponse, reconnect: boolean): void {
	if (reconnect && initialized.agentCapabilities?.loadSession !== true) {
		throw new Error("Grok ACP reconnect requires the loadSession capability.");
	}
}

function toPromptBlocks(prompt: string, images: RuntimeTaskImage[], supportsImages: boolean): ContentBlock[] {
	const blocks: ContentBlock[] = [{ type: "text", text: prompt }];
	if (images.length === 0) {
		return blocks;
	}
	if (!supportsImages) {
		throw new Error("Grok ACP did not negotiate image prompt support for this task.");
	}
	for (const image of images) {
		blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
	}
	return blocks;
}

export class GrokAcpRuntime {
	private readonly summaries = new Map<string, RuntimeTaskSessionSummary>();
	private readonly latestAttempts = new Map<string, RuntimeTaskExecutionAttemptReference>();
	private readonly active = new Map<string, ActiveGrokAcpSession>();
	private readonly pendingStarts = new Map<string, PendingGrokAcpStart>();
	private readonly pendingReconnects = new Map<string, Promise<RuntimeTaskSessionSummary>>();
	private readonly onActivity: NonNullable<GrokAcpRuntimeOptions["onActivity"]>;
	private readonly onSummary: NonNullable<GrokAcpRuntimeOptions["onSummary"]>;
	private readonly warn: NonNullable<GrokAcpRuntimeOptions["warn"]>;
	private readonly zmxControl: ZmxSessionControl;
	private readonly connect: typeof createGrokAcpConnection;
	private readonly launch: typeof launchGrokAcpServer;
	private readonly createSecret: typeof createGrokAcpSecret;
	private readonly resolveSecret: typeof resolveGrokAcpSecret;
	private readonly deleteSecret: typeof deleteGrokAcpSecret;
	private readonly connectAttempts: number;
	private readonly connectRetryMs: number;
	private acceptingConnections = true;

	constructor(options: GrokAcpRuntimeOptions = {}) {
		this.onActivity = options.onActivity ?? (() => undefined);
		this.onSummary = options.onSummary ?? (() => undefined);
		this.warn = options.warn ?? ((message) => process.stderr.write(`[kanban] ${message}\n`));
		this.zmxControl = options.zmxControl ?? createZmxSessionControl();
		this.connect = options.connect ?? createGrokAcpConnection;
		this.launch = options.launch ?? launchGrokAcpServer;
		this.createSecret = options.createSecret ?? createGrokAcpSecret;
		this.resolveSecret = options.resolveSecret ?? resolveGrokAcpSecret;
		this.deleteSecret = options.deleteSecret ?? deleteGrokAcpSecret;
		this.connectAttempts = options.connectAttempts ?? CONNECT_ATTEMPTS;
		this.connectRetryMs = options.connectRetryMs ?? CONNECT_RETRY_MS;
	}

	hydrate(
		summaries: Record<string, RuntimeTaskSessionSummary>,
		executionAttemptsByTaskId: Record<string, RuntimeTaskExecutionAttemptReference | undefined> = {},
	): void {
		for (const summary of Object.values(summaries)) {
			if (summary.agentId === "grok" && summary.acpConnection) {
				this.summaries.set(summary.taskId, cloneSummary(summary));
				this.latestAttempts.set(summary.taskId, {
					attemptId: summary.acpConnection.attemptId,
					generation: summary.acpConnection.generation,
					queuedAt: summary.acpConnection.queuedAt,
				});
			}
		}
		for (const [taskId, executionAttempt] of Object.entries(executionAttemptsByTaskId)) {
			if (executionAttempt) {
				this.latestAttempts.set(taskId, { ...executionAttempt });
			}
		}
	}

	async reconcile(): Promise<void> {
		const reconnectableSummaries = Array.from(this.summaries.values()).filter(
			(summary) =>
				Boolean(summary.durableSessionName) && (summary.state === "running" || summary.state === "awaiting_review"),
		);
		await Promise.all(
			reconnectableSummaries.map(async (summary) => {
				const identity = summary.acpConnection;
				const latestAttempt = this.latestAttempts.get(summary.taskId);
				if (identity && latestAttempt && !isSameExecutionAttempt(identity, latestAttempt)) {
					await this.stop(summary.taskId, identity.attemptId).catch((error) => {
						this.warn(
							`Could not stop stale Grok ACP session for task "${summary.taskId}": ${error instanceof Error ? error.message : String(error)}`,
						);
					});
					return;
				}
				const taskId = summary.taskId;
				await this.reconnect(taskId).catch((error) => {
					this.warn(
						`Could not reconcile the persisted Grok ACP session for task "${taskId}": ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			}),
		);
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const summary = this.summaries.get(taskId);
		return summary ? cloneSummary(summary) : null;
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const summary = this.summaries.get(taskId);
		if (!summary) {
			return null;
		}
		const latestCheckpoint = summary.latestTurnCheckpoint ?? null;
		if (latestCheckpoint?.ref === checkpoint.ref && latestCheckpoint.commit === checkpoint.commit) {
			return cloneSummary(summary);
		}
		return this.publishSummary({
			...summary,
			previousTurnCheckpoint: latestCheckpoint,
			latestTurnCheckpoint: checkpoint,
		});
	}

	private publishSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
		const snapshot = cloneSummary({ ...summary, updatedAt: now() });
		this.summaries.set(snapshot.taskId, snapshot);
		this.onSummary(cloneSummary(snapshot));
		return snapshot;
	}

	private publishStartFailure(
		request: StartGrokAcpSessionRequest,
		error: unknown,
		identity?: RuntimeGrokAcpConnectionIdentity,
	): void {
		const latestAttempt = this.latestAttempts.get(request.taskId);
		if (!latestAttempt || !isSameExecutionAttempt(latestAttempt, request.executionAttempt)) {
			return;
		}
		const previous = this.summaries.get(request.taskId);
		this.publishSummary({
			taskId: request.taskId,
			state: "failed",
			mode: request.startInPlanMode ? "plan" : "act",
			agentId: "grok",
			workspacePath: request.cwd,
			pid: null,
			startedAt: null,
			updatedAt: now(),
			lastOutputAt: previous?.lastOutputAt ?? null,
			reviewReason: "error",
			exitCode: null,
			lastHookAt: previous?.lastHookAt ?? null,
			latestHookActivity: previous?.latestHookActivity ?? null,
			warningMessage: error instanceof Error ? error.message : String(error),
			latestTurnCheckpoint: previous?.latestTurnCheckpoint ?? null,
			previousTurnCheckpoint: previous?.previousTurnCheckpoint ?? null,
			durableSessionName: null,
			acpConnection: identity ? { ...identity } : undefined,
			acpActivity: previous?.acpActivity ?? [],
			acpNextSequence: previous?.acpNextSequence ?? 1,
		});
	}

	private trackExecutionAttempt(request: StartGrokAcpSessionRequest): void {
		const latestAttempt = this.latestAttempts.get(request.taskId);
		if (latestAttempt) {
			const sameAttempt = isSameExecutionAttempt(latestAttempt, request.executionAttempt);
			if (latestAttempt.attemptId === request.executionAttempt.attemptId && !sameAttempt) {
				throw new Error(
					`Execution attempt "${request.executionAttempt.attemptId}" has inconsistent persisted identity.`,
				);
			}
			const order = compareExecutionAttempts(request.executionAttempt, latestAttempt);
			if (order < 0 || (order === 0 && !sameAttempt)) {
				throw new Error(
					`Execution attempt "${request.executionAttempt.attemptId}" cannot take ownership of task "${request.taskId}" from newer attempt "${latestAttempt.attemptId}".`,
				);
			}
		}
		this.latestAttempts.set(request.taskId, { ...request.executionAttempt });
	}

	private assertLatestExecutionAttempt(taskId: string, executionAttempt: RuntimeTaskExecutionAttemptReference): void {
		if (!this.acceptingConnections) {
			throw new Error("The Grok ACP runtime is shutting down.");
		}
		const latestAttempt = this.latestAttempts.get(taskId);
		if (latestAttempt && isSameExecutionAttempt(latestAttempt, executionAttempt)) {
			return;
		}
		throw new Error(
			`Execution attempt "${executionAttempt.attemptId}" lost ownership of task "${taskId}" to newer attempt "${latestAttempt?.attemptId ?? "unknown"}".`,
		);
	}

	private publishActivity(
		taskId: string,
		sourceConnection: GrokAcpConnection,
		notification: SessionNotification,
	): void {
		const summary = this.summaries.get(taskId);
		if (
			!summary?.acpConnection ||
			this.active.get(taskId)?.connection !== sourceConnection ||
			notification.sessionId !== summary.acpConnection.sessionId
		) {
			this.warn(`Ignoring Grok ACP update for an unexpected session on task "${taskId}".`);
			return;
		}
		const sequence = summary.acpNextSequence ?? 1;
		const activity = toRuntimeAcpActivity(notification, sequence);
		if (!activity) {
			return;
		}
		const replay = [...(summary.acpActivity ?? []), activity].slice(-MAX_REPLAY_ITEMS);
		this.publishSummary({
			...summary,
			lastOutputAt: activity.timestamp,
			acpActivity: replay,
			acpNextSequence: sequence + 1,
		});
		this.onActivity(taskId, { ...activity, plan: activity.plan?.map((entry) => ({ ...entry })) });
	}

	private createConnection(
		taskId: string,
		identity: RuntimeGrokAcpConnectionIdentity,
		secret: string,
	): GrokAcpConnection {
		let connection: GrokAcpConnection | null = null;
		connection = this.connect(
			{ endpoint: identity.endpoint, secret },
			{
				onSessionUpdate: (notification) => {
					if (connection) {
						this.publishActivity(taskId, connection, notification);
					}
				},
				onClose: () => {
					if (this.active.get(taskId)?.connection === connection) {
						this.active.delete(taskId);
					}
				},
			},
		);
		return connection;
	}

	private beginPromptTurn(taskId: string, active: ActiveGrokAcpSession, prompt: ContentBlock[]): void {
		if (active.promptPromise) {
			throw new Error(`Task "${taskId}" already has an active Grok ACP prompt turn.`);
		}
		let promptPromise: Promise<void>;
		promptPromise = active.connection
			.prompt({ sessionId: active.identity.sessionId, prompt })
			.then((response) => {
				const current = this.summaries.get(taskId);
				if (!current || this.active.get(taskId) !== active || response.stopReason !== "cancelled") {
					return;
				}
				this.publishSummary({
					...current,
					state: "interrupted",
					reviewReason: "interrupted",
					exitCode: null,
				});
			})
			.catch((error) => {
				const current = this.summaries.get(taskId);
				if (!current || this.active.get(taskId) !== active) {
					return;
				}
				this.publishSummary({
					...current,
					state: "failed",
					reviewReason: "error",
					warningMessage: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (active.promptPromise === promptPromise) {
					active.promptPromise = null;
				}
			});
		active.promptPromise = promptPromise;
	}

	private async connectAndInitialize(
		taskId: string,
		identity: RuntimeGrokAcpConnectionIdentity,
		secret: string,
		reconnect: boolean,
	): Promise<{ connection: GrokAcpConnection; initialized: InitializeResponse }> {
		let lastError: unknown;
		const attempts = reconnect ? RECONNECT_ATTEMPTS : this.connectAttempts;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const connection = this.createConnection(taskId, identity, secret);
			try {
				const initialized = await connection.initialize();
				assertCapabilities(initialized, reconnect);
				return { connection, initialized };
			} catch (error) {
				lastError = error;
				await connection.close().catch(() => undefined);
				if (attempt + 1 < attempts) {
					await delay(this.connectRetryMs);
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	async start(request: StartGrokAcpSessionRequest): Promise<RuntimeTaskSessionSummary> {
		if (!this.acceptingConnections) {
			throw new Error("The Grok ACP runtime is shutting down.");
		}
		if (!request.workspaceId.trim() || !request.executionAttempt.attemptId.trim()) {
			throw new Error("Grok ACP requires exact workspace and execution-attempt identity.");
		}
		this.trackExecutionAttempt(request);
		const pending = this.pendingStarts.get(request.taskId);
		if (pending) {
			if (isSameExecutionAttempt(pending.executionAttempt, request.executionAttempt)) {
				return await pending.promise;
			}
			await pending.promise.catch(() => undefined);
			return await this.start(request);
		}
		const promise = this.startSession(request);
		this.pendingStarts.set(request.taskId, {
			executionAttempt: { ...request.executionAttempt },
			promise,
		});
		try {
			return await promise;
		} finally {
			if (this.pendingStarts.get(request.taskId)?.promise === promise) {
				this.pendingStarts.delete(request.taskId);
			}
		}
	}

	private async startSession(request: StartGrokAcpSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const pendingReconnect = this.pendingReconnects.get(request.taskId);
		if (pendingReconnect) {
			await pendingReconnect.catch(() => undefined);
		}
		this.assertLatestExecutionAttempt(request.taskId, request.executionAttempt);
		const previousSummary = this.summaries.get(request.taskId);
		const previousIdentity = previousSummary?.acpConnection;
		const sameAttempt = previousIdentity ? isSameExecutionAttempt(previousIdentity, request.executionAttempt) : false;
		const previousActive = this.active.get(request.taskId);
		if (previousActive) {
			if (previousSummary && sameAttempt) {
				return cloneSummary(previousSummary);
			}
			this.active.delete(request.taskId);
			await previousActive.connection.cancel(previousActive.identity.sessionId).catch(() => undefined);
			await previousActive.connection.close().catch(() => undefined);
			this.assertLatestExecutionAttempt(request.taskId, request.executionAttempt);
		}
		if (previousIdentity) {
			const liveNames = await this.zmxControl.listSessionNames();
			this.assertLatestExecutionAttempt(request.taskId, request.executionAttempt);
			const previousSessionIsLive = liveNames.includes(previousIdentity.zmxSessionName);
			if (sameAttempt && previousSessionIsLive) {
				return await this.reconnect(request.taskId);
			}
			if (previousSessionIsLive) {
				await this.zmxControl.killSession(previousIdentity.zmxSessionName);
				this.assertLatestExecutionAttempt(request.taskId, request.executionAttempt);
			}
			await this.deleteSecret(previousIdentity.secretRef);
			this.assertLatestExecutionAttempt(request.taskId, request.executionAttempt);
		}
		let secret = "";
		let secretRef = "";
		try {
			({ secret, secretRef } = await this.createSecret({
				workspaceId: request.workspaceId,
				taskId: request.taskId,
				attemptId: request.executionAttempt.attemptId,
			}));
			this.assertLatestExecutionAttempt(request.taskId, request.executionAttempt);
		} catch (error) {
			if (secretRef) {
				await this.deleteSecret(secretRef).catch(() => undefined);
			}
			this.publishStartFailure(request, error);
			throw error;
		}
		let launched: Awaited<ReturnType<typeof launchGrokAcpServer>>;
		try {
			launched = await this.launch({
				binary: request.binary,
				cwd: request.cwd,
				env: request.env,
				secret,
				taskId: request.taskId,
				workspaceId: request.workspaceId,
				executionAttempt: request.executionAttempt,
			});
		} catch (error) {
			await this.deleteSecret(secretRef).catch((cleanupError) => {
				this.warn(
					`Could not remove a failed Grok ACP startup secret for task "${request.taskId}": ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			});
			this.publishStartFailure(request, error);
			throw error;
		}
		const identity: RuntimeGrokAcpConnectionIdentity = {
			transport: "websocket",
			endpoint: launched.endpoint,
			zmxSessionName: launched.zmxSessionName,
			attemptId: request.executionAttempt.attemptId,
			generation: request.executionAttempt.generation,
			queuedAt: request.executionAttempt.queuedAt,
			sessionId: "pending",
			secretRef,
		};
		let connection: GrokAcpConnection | null = null;
		try {
			const connected = await this.connectAndInitialize(request.taskId, identity, secret, false);
			connection = connected.connection;
			const initialized = connected.initialized;
			this.assertLatestExecutionAttempt(request.taskId, request.executionAttempt);
			const prompt = await prepareAgentPrompt({
				...request,
				agentId: "grok",
				args: [],
				images: undefined,
			});
			this.assertLatestExecutionAttempt(request.taskId, request.executionAttempt);
			if (request.resumeFromTrash && previousIdentity && previousIdentity.sessionId !== "pending") {
				assertCapabilities(initialized, true);
				identity.sessionId = previousIdentity.sessionId;
				await connection.loadSession({ cwd: request.cwd, sessionId: previousIdentity.sessionId });
				this.assertLatestExecutionAttempt(request.taskId, request.executionAttempt);
			} else {
				const session = await connection.newSession({
					cwd: request.cwd,
					mode: request.startInPlanMode ? "plan" : "act",
				});
				this.assertLatestExecutionAttempt(request.taskId, request.executionAttempt);
				identity.sessionId = session.sessionId;
			}
			const previousActivity = this.summaries.get(request.taskId);
			const started = this.publishSummary({
				taskId: request.taskId,
				state: request.resumeFromTrash ? "awaiting_review" : "running",
				mode: request.startInPlanMode ? "plan" : "act",
				agentId: "grok",
				workspacePath: request.cwd,
				pid: launched.pid,
				startedAt: now(),
				updatedAt: now(),
				lastOutputAt: null,
				reviewReason: request.resumeFromTrash ? "attention" : null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				warningMessage: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
				durableSessionName: launched.zmxSessionName,
				acpConnection: { ...identity },
				acpActivity: request.resumeFromTrash ? (previousActivity?.acpActivity ?? []) : [],
				acpNextSequence: request.resumeFromTrash ? (previousActivity?.acpNextSequence ?? 1) : 1,
			});
			const active: ActiveGrokAcpSession = { connection, identity, promptPromise: null };
			this.active.set(request.taskId, active);
			if (!request.resumeFromTrash || request.prompt.trim() || (request.images?.length ?? 0) > 0) {
				const promptBlocks = toPromptBlocks(
					prompt,
					request.images ?? [],
					initialized.agentCapabilities?.promptCapabilities?.image === true,
				);
				this.beginPromptTurn(request.taskId, active, promptBlocks);
			}
			return started;
		} catch (error) {
			await connection?.close().catch(() => undefined);
			await this.zmxControl.killSession(launched.zmxSessionName).catch(() => undefined);
			await this.deleteSecret(secretRef).catch((cleanupError) => {
				this.warn(
					`Could not remove a failed Grok ACP startup secret for task "${request.taskId}": ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			});
			this.publishStartFailure(request, error, identity);
			throw error;
		}
	}

	async reconnect(taskId: string): Promise<RuntimeTaskSessionSummary> {
		if (!this.acceptingConnections) {
			throw new Error("The Grok ACP runtime is shutting down.");
		}
		const current = this.summaries.get(taskId);
		if (current && this.active.has(taskId)) {
			return cloneSummary(current);
		}
		const pending = this.pendingReconnects.get(taskId);
		if (pending) {
			return await pending;
		}
		const promise = this.reconnectSession(taskId);
		this.pendingReconnects.set(taskId, promise);
		try {
			return await promise;
		} finally {
			if (this.pendingReconnects.get(taskId) === promise) {
				this.pendingReconnects.delete(taskId);
			}
		}
	}

	private async reconnectSession(taskId: string): Promise<RuntimeTaskSessionSummary> {
		const summary = this.summaries.get(taskId);
		const identity = summary?.acpConnection;
		if (!summary || !identity || identity.sessionId === "pending") {
			throw new Error(`Task "${taskId}" has no complete persisted Grok ACP identity.`);
		}
		this.assertLatestExecutionAttempt(taskId, identity);
		let connection: GrokAcpConnection | null = null;
		try {
			const liveNames = await this.zmxControl.listSessionNames();
			this.assertLatestExecutionAttempt(taskId, identity);
			if (!liveNames.includes(identity.zmxSessionName)) {
				const message = `The exact persisted Grok ACP zmx session is not running for task "${taskId}".`;
				await this.deleteSecret(identity.secretRef).catch((error) => {
					this.warn(
						`Could not remove the orphaned Grok ACP secret for task "${taskId}": ${error instanceof Error ? error.message : String(error)}`,
					);
				});
				this.publishSummary({
					...summary,
					state: "idle",
					pid: null,
					reviewReason: null,
					durableSessionName: null,
					warningMessage: message,
				});
				throw new Error(message);
			}
			const secret = await this.resolveSecret(identity.secretRef);
			this.assertLatestExecutionAttempt(taskId, identity);
			const connected = await this.connectAndInitialize(taskId, identity, secret, true);
			connection = connected.connection;
			this.assertLatestExecutionAttempt(taskId, identity);
			const reconnecting: ActiveGrokAcpSession = { connection, identity, promptPromise: null };
			this.active.set(taskId, reconnecting);
			await connection.loadSession({ cwd: summary.workspacePath ?? "", sessionId: identity.sessionId });
			this.assertLatestExecutionAttempt(taskId, identity);
			if (this.active.get(taskId) !== reconnecting) {
				throw new Error(`The Grok ACP connection closed while task "${taskId}" was reconnecting.`);
			}
			return this.publishSummary({ ...summary, pid: null, warningMessage: null });
		} catch (error) {
			if (this.active.get(taskId)?.connection === connection) {
				this.active.delete(taskId);
			}
			await connection?.close().catch(() => undefined);
			const current = this.summaries.get(taskId);
			const latestAttempt = this.latestAttempts.get(taskId);
			if (
				current?.acpConnection === identity &&
				latestAttempt &&
				isSameExecutionAttempt(latestAttempt, identity) &&
				current.state !== "idle"
			) {
				this.publishSummary({
					...current,
					state: "failed",
					pid: null,
					reviewReason: "error",
					warningMessage: error instanceof Error ? error.message : String(error),
				});
			}
			throw error;
		}
	}

	async sendPrompt(taskId: string, text: string): Promise<RuntimeTaskSessionSummary> {
		let active = this.active.get(taskId);
		if (!active) {
			await this.reconnect(taskId);
			active = this.active.get(taskId);
		}
		const summary = this.summaries.get(taskId);
		if (!active || !summary?.acpConnection) {
			throw new Error(`Task "${taskId}" has no active Grok ACP connection.`);
		}
		this.beginPromptTurn(taskId, active, [{ type: "text", text }]);
		return cloneSummary(summary);
	}

	async cancel(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const summary = this.summaries.get(taskId);
		if (!summary?.acpConnection) return null;
		let active = this.active.get(taskId);
		if (!active) {
			await this.reconnect(taskId);
			active = this.active.get(taskId);
		}
		await active?.connection.cancel(summary.acpConnection.sessionId);
		return cloneSummary(summary);
	}

	async stop(
		taskId: string,
		executionAttemptId?: string | null,
		options?: { publishSummary?: boolean },
	): Promise<RuntimeTaskSessionSummary | null> {
		const summary = this.summaries.get(taskId);
		if (!summary?.acpConnection) return null;
		if (executionAttemptId !== undefined && summary.acpConnection.attemptId !== executionAttemptId) {
			return null;
		}
		const active = this.active.get(taskId);
		if (active) {
			await active.connection.cancel(summary.acpConnection.sessionId).catch(() => undefined);
			await active.connection.close().catch(() => undefined);
			this.active.delete(taskId);
		}
		const liveNames = await this.zmxControl.listSessionNames();
		if (liveNames.includes(summary.acpConnection.zmxSessionName)) {
			await this.zmxControl.killSession(summary.acpConnection.zmxSessionName);
		}
		await this.deleteSecret(summary.acpConnection.secretRef);
		const stopped = {
			...summary,
			state: "idle",
			pid: null,
			reviewReason: null,
			exitCode: 0,
			durableSessionName: null,
		} satisfies RuntimeTaskSessionSummary;
		return options?.publishSummary === false ? cloneSummary(stopped) : this.publishSummary(stopped);
	}

	async stopAll(): Promise<void> {
		this.acceptingConnections = false;
		await Promise.all([
			...Array.from(this.pendingStarts.values(), ({ promise }) => promise.catch(() => undefined)),
			...Array.from(this.pendingReconnects.values(), (promise) => promise.catch(() => undefined)),
		]);
		await Promise.all(
			Array.from(
				this.summaries.keys(),
				async (taskId) => await this.stop(taskId, undefined, { publishSummary: false }),
			),
		);
	}

	async shutdown(): Promise<void> {
		this.acceptingConnections = false;
		await Promise.all([
			...Array.from(this.pendingStarts.values(), ({ promise }) => promise.catch(() => undefined)),
			...Array.from(this.pendingReconnects.values(), (promise) => promise.catch(() => undefined)),
		]);
		for (const [taskId, active] of this.active) {
			await active.connection.close().catch(() => undefined);
			this.active.delete(taskId);
		}
	}
}
