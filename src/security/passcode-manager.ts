/**
 * Passcode manager for remotely-hosted Kanban instances.
 *
 * Security properties:
 * - Passcode is generated via crypto.randomBytes — cryptographically secure.
 * - Passcode lives in-memory only — never written to disk, never in env vars.
 * - Each process has its own independent passcode.
 * - Comparison uses crypto.timingSafeEqual to prevent timing attacks.
 * - Sessions are random tokens stored in-memory with TTL metadata.
 * - Rate limiting: 5 failed attempts triggers a 30-second lockout.
 * - Passcode is NEVER returned in any response, log, or error message.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const PASSCODE_LENGTH = 8;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_LOCKOUT_MS = 30 * 1000; // 30 seconds

interface PasscodeState {
	value: string;
	issuedAt: number;
}

interface SessionEntry {
	issuedAt: number;
}

interface RateLimitEntry {
	attempts: number;
	lockedUntil: number | null;
}

const INTERNAL_TOKEN_ENV = "KANBAN_INTERNAL_AUTH_TOKEN";
export const INTERNAL_TOKEN_FILE_ENV = "KANBAN_INTERNAL_AUTH_TOKEN_FILE";
const INTERNAL_TOKEN_FILENAME = "internal-auth-token";
const INTERNAL_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

let passcodeState: PasscodeState | null = null;
let passcodeEnabled = true;
let internalAuthToken: string | null = null;

const sessions = new Map<string, SessionEntry>();
const rateLimitByIp = new Map<string, RateLimitEntry>();

function generateRandomPasscode(): string {
	// Exclude visually ambiguous chars: 0/O, 1/I/l
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
	let result = "";
	while (result.length < PASSCODE_LENGTH) {
		const bytes = randomBytes(PASSCODE_LENGTH * 2);
		for (let i = 0; i < bytes.length && result.length < PASSCODE_LENGTH; i++) {
			const byte = bytes[i];
			if (byte === undefined) continue;
			// Rejection sampling to avoid modulo bias
			if (byte < chars.length * Math.floor(256 / chars.length)) {
				result += chars[byte % chars.length];
			}
		}
	}
	return result;
}

/**
 * Generate a new passcode. Called once at server startup when remote mode is active.
 * Returns the plaintext passcode for console display ONLY.
 */
export function generatePasscode(): string {
	const value = generateRandomPasscode();
	passcodeState = { value, issuedAt: Date.now() };
	passcodeEnabled = true;
	return value;
}

/** Disable passcode enforcement (--no-passcode flag). */
export function disablePasscode(): void {
	passcodeEnabled = false;
	passcodeState = null;
}

/** Whether passcode enforcement is currently active. */
export function isPasscodeEnabled(): boolean {
	return passcodeEnabled;
}

/**
 * Revoke the current passcode and generate a new one.
 * Returns the new plaintext passcode for display.
 */
export function revokeAndRegeneratePasscode(): string {
	sessions.clear();
	rateLimitByIp.clear();
	return generatePasscode();
}

/**
 * Validate a submitted passcode. Uses timing-safe comparison.
 */
export function validatePasscode(submitted: string): boolean {
	if (!passcodeEnabled || !passcodeState) return false;
	if (typeof submitted !== "string" || submitted.length === 0) return false;

	const expectedBuf = Buffer.from(passcodeState.value, "utf8");
	const submittedPadded = Buffer.alloc(expectedBuf.length, 0);
	const submittedBuf = Buffer.from(submitted, "utf8");
	submittedBuf.copy(submittedPadded, 0, 0, Math.min(submittedBuf.length, submittedPadded.length));

	const lengthMatch = submittedBuf.length === expectedBuf.length;
	const bytesMatch = timingSafeEqual(submittedPadded, expectedBuf);
	return lengthMatch && bytesMatch;
}

/** Issue a new session token after successful passcode verification. */
export function issueSession(): string {
	const token = randomBytes(32).toString("hex");
	sessions.set(token, { issuedAt: Date.now() });
	return token;
}

/** Validate a session token. Returns true if valid and not expired. */
export function validateSession(token: string): boolean {
	const entry = sessions.get(token);
	if (!entry) return false;
	if (Date.now() - entry.issuedAt > SESSION_TTL_MS) {
		sessions.delete(token);
		return false;
	}
	return true;
}

/** Extract the session token from a Cookie header string. */
export function extractSessionTokenFromCookie(cookieHeader: string | undefined): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const trimmed = part.trim();
		if (trimmed.startsWith("kanban_session=")) {
			const value = trimmed.slice("kanban_session=".length).trim();
			return value || null;
		}
	}
	return null;
}

export interface RateLimitResult {
	allowed: boolean;
	lockedUntilMs: number | null;
	attemptsRemaining: number;
}

/** Check rate limit for a given IP address before a passcode attempt. */
export function checkRateLimit(ip: string): RateLimitResult {
	const now = Date.now();
	let entry = rateLimitByIp.get(ip);
	if (!entry) {
		entry = { attempts: 0, lockedUntil: null };
		rateLimitByIp.set(ip, entry);
	}
	if (entry.lockedUntil !== null && now >= entry.lockedUntil) {
		entry.attempts = 0;
		entry.lockedUntil = null;
	}
	if (entry.lockedUntil !== null) {
		return { allowed: false, lockedUntilMs: entry.lockedUntil, attemptsRemaining: 0 };
	}
	return {
		allowed: true,
		lockedUntilMs: null,
		attemptsRemaining: Math.max(0, RATE_LIMIT_MAX_ATTEMPTS - entry.attempts),
	};
}

/** Record a failed passcode attempt for rate limiting. */
export function recordFailedAttempt(ip: string): void {
	const now = Date.now();
	let entry = rateLimitByIp.get(ip);
	if (!entry) {
		entry = { attempts: 0, lockedUntil: null };
		rateLimitByIp.set(ip, entry);
	}
	entry.attempts += 1;
	if (entry.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
		entry.lockedUntil = now + RATE_LIMIT_LOCKOUT_MS;
	}
}

/** Clear rate limit for a given IP after a successful verification. */
export function clearRateLimit(ip: string): void {
	rateLimitByIp.delete(ip);
}

// ── Internal CLI auth token ──────────────────────────────────────────────
// A separate bearer token used by CLI sub-processes (hooks ingest, task
// commands) to authenticate against the runtime server without the
// browser-facing passcode flow.  The token is:
//   • Loaded from an explicit environment override when one is configured.
//   • Otherwise persisted in an owner-only local file so independently
//     launched Kanban processes share the same authenticated boundary.
//   • Propagated via KANBAN_INTERNAL_AUTH_TOKEN for child process inheritance.
//   • Never exposed to browser clients.

function createInternalToken(): string {
	return randomBytes(32).toString("hex");
}

function getInternalTokenFilePath(): string {
	return process.env[INTERNAL_TOKEN_FILE_ENV]?.trim() || join(homedir(), ".cline", "kanban", INTERNAL_TOKEN_FILENAME);
}

function assertOwnedByCurrentUser(uid: number, path: string): void {
	const currentUid = process.geteuid?.();
	if (currentUid !== undefined && uid !== currentUid) {
		throw new Error(`Kanban internal auth path is not owned by the current user: ${path}`);
	}
}

function ensurePrivateTokenDirectory(tokenDirectory: string): void {
	mkdirSync(tokenDirectory, { recursive: true, mode: 0o700 });
	const directory = lstatSync(tokenDirectory);
	if (!directory.isDirectory() || directory.isSymbolicLink()) {
		throw new Error(`Kanban internal auth token directory is not a regular directory: ${tokenDirectory}`);
	}
	assertOwnedByCurrentUser(directory.uid, tokenDirectory);
	if (process.platform !== "win32" && (directory.mode & 0o077) !== 0) {
		chmodSync(tokenDirectory, 0o700);
	}
}

function publishInternalToken(tokenPath: string): void {
	const tokenDirectory = dirname(tokenPath);
	const temporaryPath = join(
		tokenDirectory,
		`.${basename(tokenPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	let temporaryFd: number | null = null;
	try {
		temporaryFd = openSync(
			temporaryPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeFileSync(temporaryFd, `${createInternalToken()}\n`, "utf8");
		fsyncSync(temporaryFd);
		closeSync(temporaryFd);
		temporaryFd = null;
		try {
			linkSync(temporaryPath, tokenPath);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
				throw error;
			}
		}
	} finally {
		if (temporaryFd !== null) {
			closeSync(temporaryFd);
		}
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The unpublished file is owner-only inside an owner-only directory.
			// Cleanup must not mask the credential publication/read result.
		}
	}
}

function readInternalToken(tokenPath: string): string {
	const tokenFd = openSync(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const tokenFile = fstatSync(tokenFd);
		if (!tokenFile.isFile()) {
			throw new Error(`Kanban internal auth token path is not a regular file: ${tokenPath}`);
		}
		assertOwnedByCurrentUser(tokenFile.uid, tokenPath);
		if (process.platform !== "win32" && (tokenFile.mode & 0o077) !== 0) {
			fchmodSync(tokenFd, 0o600);
		}

		const persistedToken = readFileSync(tokenFd, "utf8").trim();
		if (!INTERNAL_TOKEN_PATTERN.test(persistedToken)) {
			throw new Error(`Kanban internal auth token file is invalid: ${tokenPath}`);
		}
		return persistedToken;
	} finally {
		closeSync(tokenFd);
	}
}

/**
 * Load the internal bearer token, creating an owner-only local token file on
 * first use. The file is the rendezvous point for independently launched
 * local processes such as the Kanban runtime and the Absurd worker.
 */
export function initializeInternalToken(tokenPath = getInternalTokenFilePath()): string {
	const configuredToken = process.env[INTERNAL_TOKEN_ENV]?.trim();
	if (configuredToken) {
		internalAuthToken = configuredToken;
		return configuredToken;
	}

	ensurePrivateTokenDirectory(dirname(tokenPath));
	try {
		lstatSync(tokenPath);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			publishInternalToken(tokenPath);
		} else {
			throw error;
		}
	}
	const persistedToken = readInternalToken(tokenPath);

	internalAuthToken = persistedToken;
	process.env[INTERNAL_TOKEN_ENV] = persistedToken;
	return persistedToken;
}

/**
 * Generate (or regenerate) the internal CLI auth token.
 * Called by the server at startup when remote-mode passcode is active.
 * The token is stored in-memory and written to `process.env` so that
 * child processes inherit it.
 */
export function generateInternalToken(): string {
	const token = createInternalToken();
	internalAuthToken = token;
	process.env[INTERNAL_TOKEN_ENV] = token;
	return token;
}

/**
 * Return the current internal token, reading from the env var if needed
 * (this covers CLI sub-processes that were spawned by the server).
 */
export function getInternalToken(): string | null {
	return internalAuthToken ?? (process.env[INTERNAL_TOKEN_ENV]?.trim() || null);
}

/**
 * Validate an internal bearer token.  Uses timing-safe comparison.
 * Returns `true` if the submitted token matches the active internal token.
 */
export function validateInternalToken(submitted: string): boolean {
	const expected = internalAuthToken;
	if (!expected) return false;
	if (typeof submitted !== "string" || submitted.length === 0) return false;

	const expectedBuf = Buffer.from(expected, "utf8");
	const submittedBuf = Buffer.from(submitted, "utf8");
	if (expectedBuf.length !== submittedBuf.length) return false;

	return timingSafeEqual(submittedBuf, expectedBuf);
}

/**
 * Extract a bearer token from an Authorization header value.
 * Returns the raw token string or `null` if the header is absent / malformed.
 */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
	if (!authorizationHeader) return null;
	const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader);
	return match?.[1] ?? null;
}

/** Name of the env var used to propagate the internal token to child processes. */
export { INTERNAL_TOKEN_ENV };
