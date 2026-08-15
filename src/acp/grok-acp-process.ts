import { spawn } from "node:child_process";
import { createServer } from "node:net";

import type { RuntimeTaskExecutionAttemptReference } from "../core/api-contract";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import { prepareZmxAgentSession } from "../terminal/zmx-agent-session";

export interface LaunchGrokAcpServerInput {
	binary: string;
	cwd: string;
	env?: Record<string, string | undefined>;
	secret: string;
	taskId: string;
	workspaceId: string;
	executionAttempt: RuntimeTaskExecutionAttemptReference;
}

export interface GrokAcpServerLaunch {
	endpoint: string;
	port: number;
	pid: number | null;
	zmxSessionName: string;
}

async function reserveLoopbackPort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a loopback port for Grok ACP."));
				return;
			}
			const port = address.port;
			server.close((error) => {
				if (error) reject(error);
				else resolve(port);
			});
		});
	});
}

export function buildGrokServeArgs(port: number): string[] {
	return ["agent", "--always-approve", "serve", "--bind", `127.0.0.1:${port}`];
}

export async function launchGrokAcpServer(input: LaunchGrokAcpServerInput): Promise<GrokAcpServerLaunch> {
	if (!isBinaryAvailableOnPath("zmx")) {
		throw new Error(
			"Grok ACP requires zmx for durable process ownership; use the explicit terminal rescue path instead.",
		);
	}
	const port = await reserveLoopbackPort();
	const zmxLaunch = prepareZmxAgentSession({
		agentId: "grok",
		binary: input.binary,
		args: buildGrokServeArgs(port),
		taskId: `${input.taskId}-${input.executionAttempt.attemptId}`,
		workspaceId: input.workspaceId,
		zmxAvailable: true,
	});
	if (!zmxLaunch) {
		throw new Error("Could not construct the exact durable Grok ACP zmx identity.");
	}

	const env: NodeJS.ProcessEnv = { ...process.env, ...input.env, GROK_AGENT_SECRET: input.secret };
	delete env.ZMX_SESSION;
	const child = spawn(zmxLaunch.binary, zmxLaunch.args, {
		cwd: input.cwd,
		env,
		stdio: "ignore",
		detached: false,
	});
	const pid = child.pid ?? null;
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	child.unref();
	return {
		endpoint: `ws://127.0.0.1:${port}/ws`,
		port,
		pid,
		zmxSessionName: zmxLaunch.sessionName,
	};
}
