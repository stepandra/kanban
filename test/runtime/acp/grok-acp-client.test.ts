import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { createGrokAcpConnection } from "../../../src/acp/grok-acp-client";

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

interface FakeAcpServer {
	server: Server;
	webSocketServer: WebSocketServer;
	url: string;
	requests: JsonRpcRequest[];
	authorizationHeaders: string[];
	notify: (method: string, params: Record<string, unknown>) => void;
	close: () => Promise<void>;
}

async function createFakeAcpServer(authMethods: Array<Record<string, unknown>>): Promise<FakeAcpServer> {
	const requests: JsonRpcRequest[] = [];
	const authorizationHeaders: string[] = [];
	const server = createServer();
	const webSocketServer = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		authorizationHeaders.push(request.headers.authorization ?? "");
		webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
			webSocketServer.emit("connection", webSocket, request);
		});
	});
	webSocketServer.on("connection", (socket) => {
		socket.on("message", (raw) => {
			const request = JSON.parse(String(raw)) as JsonRpcRequest;
			requests.push(request);
			if (request.id === undefined || !request.method) {
				return;
			}
			let result: Record<string, unknown>;
			switch (request.method) {
				case "initialize":
					result = {
						protocolVersion: 1,
						agentCapabilities: { loadSession: true },
						authMethods,
					};
					break;
				case "authenticate":
					result = {};
					break;
				case "session/new":
					result = { sessionId: "session-1" };
					break;
				case "session/prompt":
					result = { stopReason: "end_turn" };
					break;
				default:
					result = {};
			}
			socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Fake ACP server did not bind.");
	}
	return {
		server,
		webSocketServer,
		url: `ws://127.0.0.1:${address.port}`,
		requests,
		authorizationHeaders,
		notify: (method, params) => {
			for (const client of webSocketServer.clients) {
				client.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
			}
		},
		close: async () => {
			for (const client of webSocketServer.clients) {
				client.terminate();
			}
			await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

describe("Grok ACP client authentication", () => {
	const servers: FakeAcpServer[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map(async (server) => await server.close()));
	});

	it("selects xai.api_key before creating a session even when cached OIDC is advertised first", async () => {
		const server = await createFakeAcpServer([
			{ id: "xai.oidc", name: "Cached xAI login" },
			{ id: "xai.api_key", name: "xAI API key", type: "env_var", vars: [{ name: "XAI_API_KEY" }] },
		]);
		servers.push(server);
		const connection = createGrokAcpConnection(
			{ endpoint: server.url, secret: "transport-secret" },
			{ onSessionUpdate: () => undefined },
		);

		await connection.initialize();
		await connection.newSession({ cwd: "/tmp/workspace" });

		expect(server.requests.map((request) => request.method)).toEqual(["initialize", "authenticate", "session/new"]);
		expect(server.requests[1]?.params).toEqual({ methodId: "xai.api_key" });
		expect(server.authorizationHeaders).toEqual(["Bearer transport-secret"]);
		await connection.close();
	});

	it("exchanges typed prompt, update, and cancellation messages over the authenticated transport", async () => {
		const server = await createFakeAcpServer([{ id: "xai.api_key", name: "xAI API key" }]);
		servers.push(server);
		const onSessionUpdate = vi.fn();
		const connection = createGrokAcpConnection(
			{ endpoint: server.url, secret: "transport-secret" },
			{ onSessionUpdate },
		);

		await connection.initialize();
		const session = await connection.newSession({ cwd: "/tmp/workspace" });
		server.notify("session/update", {
			sessionId: session.sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "tool-1",
				title: "Inspect repository",
				status: "in_progress",
			},
		});
		await vi.waitFor(() => expect(onSessionUpdate).toHaveBeenCalledOnce());
		await expect(
			connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "Implement ACP" }] }),
		).resolves.toEqual({ stopReason: "end_turn" });
		await connection.cancel(session.sessionId);
		await vi.waitFor(() =>
			expect(server.requests.map((request) => request.method)).toEqual([
				"initialize",
				"authenticate",
				"session/new",
				"session/prompt",
				"session/cancel",
			]),
		);
		expect(onSessionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-1", update: expect.objectContaining({ toolCallId: "tool-1" }) }),
		);
		await connection.close();
	});

	it("fails closed instead of falling back to cached OIDC", async () => {
		const server = await createFakeAcpServer([{ id: "xai.oidc", name: "Cached xAI login" }]);
		servers.push(server);
		const connection = createGrokAcpConnection(
			{ endpoint: server.url, secret: "transport-secret" },
			{ onSessionUpdate: () => undefined },
		);

		await expect(connection.initialize()).rejects.toThrow(
			"Grok ACP did not advertise task-scoped xAI API-key authentication.",
		);
		expect(server.requests.map((request) => request.method)).toEqual(["initialize"]);
		await connection.close();
	});
});
