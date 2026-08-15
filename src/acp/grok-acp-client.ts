import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";

const ACP_REQUEST_TIMEOUT_MS = 30_000;
const XAI_API_KEY_AUTH_METHOD_ID = "xai.api_key";

export interface GrokAcpConnectionIdentity {
	endpoint: string;
	secret: string;
}

export interface GrokAcpConnectionCallbacks {
	onSessionUpdate: (notification: acp.SessionNotification) => void | Promise<void>;
	onClose?: () => void;
}

export interface GrokAcpConnection {
	initialize(): Promise<acp.InitializeResponse>;
	newSession(input: { cwd: string; mode?: "act" | "plan" }): Promise<acp.NewSessionResponse>;
	loadSession(input: { cwd: string; sessionId: string }): Promise<acp.LoadSessionResponse>;
	prompt(input: { sessionId: string; prompt: acp.ContentBlock[] }): Promise<acp.PromptResponse>;
	cancel(sessionId: string): Promise<void>;
	close(): Promise<void>;
}

function createTimeoutSignal(timeoutMs = ACP_REQUEST_TIMEOUT_MS): AbortSignal {
	return AbortSignal.timeout(timeoutMs);
}

function chooseAlwaysApproveOption(options: acp.PermissionOption[]): acp.PermissionOption | null {
	return (
		options.find((option) => option.kind === "allow_always") ??
		options.find((option) => option.kind === "allow_once") ??
		null
	);
}

export function selectXaiApiKeyAuthMethod(authMethods: acp.AuthMethod[]): acp.AuthMethod | null {
	return authMethods.find((method) => method.id === XAI_API_KEY_AUTH_METHOD_ID) ?? null;
}

export function createGrokAcpConnection(
	identity: GrokAcpConnectionIdentity,
	callbacks: GrokAcpConnectionCallbacks,
): GrokAcpConnection {
	const stream = createWebSocketStream(identity.endpoint, {
		WebSocket,
		headers: {
			Authorization: `Bearer ${identity.secret}`,
		},
		cookies: "omit",
	});
	const app = acp
		.client({ name: "kanban-grok-acp" })
		.onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
			const option = chooseAlwaysApproveOption(params.options);
			return option
				? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
				: { outcome: { outcome: "cancelled" as const } };
		})
		.onNotification(acp.methods.client.session.update, async ({ params }) => {
			await callbacks.onSessionUpdate(params);
		});
	const connection = app.connect(stream);
	void connection.closed.then(
		() => callbacks.onClose?.(),
		() => callbacks.onClose?.(),
	);

	return {
		async initialize() {
			const initialized = await connection.agent.request(
				acp.methods.agent.initialize,
				{
					protocolVersion: acp.PROTOCOL_VERSION,
					clientCapabilities: { plan: {} },
					clientInfo: { name: "kanban", version: "0.1" },
				},
				{ cancellationSignal: createTimeoutSignal() },
			);
			if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
				throw new Error(
					`Grok ACP negotiated unsupported protocol version ${initialized.protocolVersion}; expected ${acp.PROTOCOL_VERSION}.`,
				);
			}
			const authMethod = selectXaiApiKeyAuthMethod(initialized.authMethods ?? []);
			if (!authMethod) {
				throw new Error("Grok ACP did not advertise task-scoped xAI API-key authentication.");
			}
			await connection.agent.request(
				acp.methods.agent.authenticate,
				{ methodId: authMethod.id },
				{ cancellationSignal: createTimeoutSignal() },
			);
			return initialized;
		},
		async newSession(input) {
			const created = await connection.agent.request(
				acp.methods.agent.session.new,
				{
					cwd: input.cwd,
					mcpServers: [],
					_meta: { yoloMode: true },
				},
				{ cancellationSignal: createTimeoutSignal() },
			);
			if (input.mode === "plan") {
				const planMode = created.modes?.availableModes.find((mode) => mode.id === "plan");
				if (!planMode) {
					throw new Error("Grok ACP did not advertise the requested plan mode.");
				}
				await connection.agent.request(
					acp.methods.agent.session.setMode,
					{ sessionId: created.sessionId, modeId: planMode.id },
					{ cancellationSignal: createTimeoutSignal() },
				);
			}
			return created;
		},
		async loadSession(input) {
			return await connection.agent.request(
				acp.methods.agent.session.load,
				{
					cwd: input.cwd,
					mcpServers: [],
					sessionId: input.sessionId,
					_meta: { yoloMode: true },
				},
				{ cancellationSignal: createTimeoutSignal() },
			);
		},
		async prompt(input) {
			return await connection.agent.request(acp.methods.agent.session.prompt, input, {
				cancellationSignal: createTimeoutSignal(24 * 60 * 60 * 1_000),
			});
		},
		async cancel(sessionId) {
			await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
		},
		async close() {
			connection.close();
			try {
				await stream.writable.close();
			} catch {
				// The transport may already be closed after a disconnect.
			}
		},
	};
}
