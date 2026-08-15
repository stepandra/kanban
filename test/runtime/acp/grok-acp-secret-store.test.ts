import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspaceStateMocks = vi.hoisted(() => ({ runtimeHome: "" }));

vi.mock("../../../src/state/workspace-state.js", () => ({
	getRuntimeHomePath: () => workspaceStateMocks.runtimeHome,
}));

import { createGrokAcpSecret, deleteGrokAcpSecret, resolveGrokAcpSecret } from "../../../src/acp/grok-acp-secret-store";

describe("Grok ACP secret store", () => {
	beforeEach(() => {
		workspaceStateMocks.runtimeHome = mkdtempSync(join(tmpdir(), "kanban-grok-acp-secret-"));
	});

	afterEach(() => {
		rmSync(workspaceStateMocks.runtimeHome, { recursive: true, force: true });
	});

	it("keeps a reconnectable owner-only secret and removes it on teardown", async () => {
		const created = await createGrokAcpSecret({ workspaceId: "workspace", taskId: "task", attemptId: "attempt" });
		const path = created.secretRef.slice("kanban-secret-file:".length);

		expect(await resolveGrokAcpSecret(created.secretRef)).toBe(created.secret);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o077).toBe(0);
		}

		await deleteGrokAcpSecret(created.secretRef);
		await expect(resolveGrokAcpSecret(created.secretRef)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects references outside the runtime secret directory", async () => {
		const outside = join(workspaceStateMocks.runtimeHome, "outside.secret");
		writeFileSync(outside, "not-a-transport-secret\n", { mode: 0o600 });

		await expect(resolveGrokAcpSecret(`kanban-secret-file:${outside}`)).rejects.toThrow(
			"escapes the runtime secret directory",
		);
	});

	it.runIf(process.platform !== "win32")("does not follow a pre-existing secret-file symlink", async () => {
		const outside = join(workspaceStateMocks.runtimeHome, "outside.secret");
		writeFileSync(outside, "not-a-transport-secret\n", { mode: 0o600 });
		const input = { workspaceId: "workspace", taskId: "task", attemptId: "attempt" };
		const created = await createGrokAcpSecret(input);
		const path = created.secretRef.slice("kanban-secret-file:".length);
		await deleteGrokAcpSecret(created.secretRef);
		symlinkSync(outside, path);

		await expect(createGrokAcpSecret(input)).rejects.toThrow("not a regular file");
	});

	it.runIf(process.platform !== "win32")("does not follow a pre-existing workspace-directory symlink", async () => {
		const secretRoot = join(workspaceStateMocks.runtimeHome, "acp-secrets");
		const outside = join(workspaceStateMocks.runtimeHome, "outside");
		mkdirSync(secretRoot, { recursive: true });
		mkdirSync(outside);
		const input = { workspaceId: "workspace", taskId: "task", attemptId: "attempt" };
		const created = await createGrokAcpSecret(input);
		const workspaceDirectory = join(created.secretRef.slice("kanban-secret-file:".length), "..");
		await deleteGrokAcpSecret(created.secretRef);
		rmSync(workspaceDirectory, { recursive: true });
		symlinkSync(outside, workspaceDirectory);

		await expect(createGrokAcpSecret(input)).rejects.toThrow("not a regular directory");
	});
});
