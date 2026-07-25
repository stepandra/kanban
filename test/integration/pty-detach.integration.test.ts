import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PtySession } from "../../src/terminal/pty-session";
import { createTempDir } from "../utilities/temp-dir";

// Durability contract for PtySession.detach(): terminatePtyProcess sends
// SIGTERM to the PTY client's WHOLE process group, so a wrapped agent only
// survives detach if its launcher daemonized it into a separate process
// group. These tests prove that assumption against a real zmx session (when
// zmx is on PATH) and against a stub harness that mimics zmx by spawning a
// detached (own-process-group) child.

const isUnix = process.platform !== "win32";

function isZmxAvailable(): boolean {
	const result = spawnSync("zmx", ["--version"], { stdio: "ignore" });
	return !result.error && result.status === 0;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killQuietly(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

function processGroupId(pid: number): number {
	const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		throw new Error(`Failed to read process group for pid ${pid}: ${result.stderr || result.error}`);
	}
	return Number.parseInt(result.stdout.trim(), 10);
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return condition();
}

async function readWrappedPid(markerPath: string): Promise<number> {
	const found = await waitFor(() => {
		try {
			return Number.parseInt(readFileSync(markerPath, "utf8").trim(), 10) > 0;
		} catch {
			return false;
		}
	});
	if (!found) {
		throw new Error(`Wrapped process never wrote its pid marker at ${markerPath}`);
	}
	return Number.parseInt(readFileSync(markerPath, "utf8").trim(), 10);
}

async function expectDetachToKeepWrappedProcessAlive(input: {
	binary: string;
	args: string[];
	markerPath: string;
	cwd: string;
	env?: Record<string, string | undefined>;
}): Promise<number> {
	const session = PtySession.spawn({
		binary: input.binary,
		args: input.args,
		cwd: input.cwd,
		env: input.env,
		cols: 80,
		rows: 24,
	});
	const clientPid = session.pid;
	const wrappedPid = await readWrappedPid(input.markerPath);

	// The durability premise: the wrapped process leads its own process group,
	// distinct from the PTY client's group.
	expect(processGroupId(wrappedPid)).toBe(wrappedPid);
	expect(processGroupId(clientPid)).not.toBe(processGroupId(wrappedPid));

	session.detach();

	const clientGone = await waitFor(() => !isProcessAlive(clientPid), 5_000);
	expect(clientGone).toBe(true);
	// Allow any delayed signal fallout, then assert the wrapped process survived.
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(isProcessAlive(wrappedPid)).toBe(true);
	return wrappedPid;
}

// Stub harness mimicking zmx: the PTY client (this script) spawns a detached
// child — detached: true makes the child a process-group leader, exactly the
// property detach() relies on — records the child's pid, then idles as the
// "client" until killed. The child outlives the client, like the zmx daemon.
const STUB_CLIENT_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
	detached: true,
	stdio: "ignore",
});
writeFileSync(process.argv[1], String(child.pid));
setTimeout(() => {}, 60000);
`;

const describeUnix = describe.skipIf(!isUnix);

describeUnix("PtySession.detach() process-group durability (skipped on win32: process-group signals N/A)", () => {
	it("keeps a daemonized child alive when the client process group is terminated (stub harness)", async () => {
		const { path: tempDir, cleanup } = createTempDir("kanban-detach-stub-");
		let wrappedPid: number | undefined;
		try {
			const markerPath = join(tempDir, "wrapped.pid");
			wrappedPid = await expectDetachToKeepWrappedProcessAlive({
				binary: process.execPath,
				args: ["-e", STUB_CLIENT_SCRIPT, markerPath],
				markerPath,
				cwd: tempDir,
			});
		} finally {
			if (wrappedPid !== undefined) {
				killQuietly(wrappedPid);
			}
			cleanup();
		}
	});

	const zmxAvailable = isZmxAvailable();

	it.skipIf(!zmxAvailable)(
		"keeps the zmx-daemonized process alive after detach() (requires zmx on PATH)",
		async () => {
			const { path: tempDir, cleanup } = createTempDir("kanban-detach-zmx-");
			// zmx bounds session-name length by socket-dir path length; keep the
			// name short so it fits under a per-test ZMX_DIR in a deep temp path.
			const sessionName = `kdt-${process.pid}`;
			// Isolate zmx state per test and mirror production: a zmx holder must
			// start as a sibling, never inherit ZMX_SESSION from a parent zmx.
			const zmxDir = join(tempDir, "zmx-dir");
			mkdirSync(zmxDir, { recursive: true });
			const zmxEnv: NodeJS.ProcessEnv = { ...process.env, ZMX_DIR: zmxDir };
			delete zmxEnv.ZMX_SESSION;
			let wrappedPid: number | undefined;
			try {
				const markerPath = join(tempDir, "wrapped.pid");
				wrappedPid = await expectDetachToKeepWrappedProcessAlive({
					binary: "zmx",
					args: ["attach", sessionName, "sh", "-c", `echo $$ > "$1"; exec sleep 60`, "sh", markerPath],
					markerPath,
					cwd: tempDir,
					env: zmxEnv,
				});
			} finally {
				if (wrappedPid !== undefined) {
					killQuietly(wrappedPid);
				}
				spawnSync("zmx", ["kill", sessionName], { stdio: "ignore", env: zmxEnv });
				cleanup();
			}
		},
	);
});
