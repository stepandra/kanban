import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import { getRuntimeHomePath } from "../state/workspace-state";

const SECRET_REFERENCE_PREFIX = "kanban-secret-file:";

function secretRoot(): string {
	return join(getRuntimeHomePath(), "acp-secrets");
}

function safeSegment(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 32);
	const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
	return `${normalized || "unknown"}-${digest}`;
}

function secretPath(input: { workspaceId: string; taskId: string; attemptId: string }): string {
	return join(
		secretRoot(),
		safeSegment(input.workspaceId),
		`${safeSegment(input.taskId)}-${safeSegment(input.attemptId)}.secret`,
	);
}

function resolveSecretPath(secretRef: string): string {
	if (!secretRef.startsWith(SECRET_REFERENCE_PREFIX)) {
		throw new Error("The persisted Grok ACP secret reference is invalid.");
	}
	const path = secretRef.slice(SECRET_REFERENCE_PREFIX.length);
	const relativePath = relative(secretRoot(), path);
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(relativePath)
	) {
		throw new Error("The persisted Grok ACP secret reference escapes the runtime secret directory.");
	}
	return path;
}

async function assertRegularSecretFile(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error("The persisted Grok ACP secret reference is not a regular file.");
	}
}

async function assertPrivateDirectory(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error("The Grok ACP secret directory is not a regular directory.");
	}
	await chmod(path, 0o700);
}

export async function createGrokAcpSecret(input: {
	workspaceId: string;
	taskId: string;
	attemptId: string;
}): Promise<{ secret: string; secretRef: string }> {
	const path = secretPath(input);
	const secret = randomBytes(32).toString("base64url");
	await mkdir(secretRoot(), { recursive: true, mode: 0o700 });
	await assertPrivateDirectory(secretRoot());
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await assertPrivateDirectory(dirname(path));
	await writeFile(path, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async (error) => {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
			throw error;
		}
	});
	await assertRegularSecretFile(path);
	await chmod(path, 0o600);
	const stored = (await readFile(path, "utf8")).trim();
	if (!stored) {
		throw new Error("The Grok ACP secret reference resolved to an empty secret.");
	}
	return { secret: stored, secretRef: `${SECRET_REFERENCE_PREFIX}${path}` };
}

export async function resolveGrokAcpSecret(secretRef: string): Promise<string> {
	const path = resolveSecretPath(secretRef);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error("The persisted Grok ACP secret reference is not a regular file.");
	}
	if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
		throw new Error("The persisted Grok ACP secret reference is not owner-only.");
	}
	const secret = (await readFile(path, "utf8")).trim();
	if (!secret) {
		throw new Error("The persisted Grok ACP secret reference is empty.");
	}
	return secret;
}

export async function deleteGrokAcpSecret(secretRef: string): Promise<void> {
	const path = resolveSecretPath(secretRef);
	try {
		await assertRegularSecretFile(path);
		await unlink(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return;
		}
		throw error;
	}
}
