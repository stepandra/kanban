import { createHash } from "node:crypto";

import type { RuntimeTaskWorkspaceReceipt, RuntimeWorkspaceChangesResponse } from "../core/api-contract";
import { detectRepositoryKind } from "../state/workspace-state";
import { getJjWorkspaceChanges, getWorkspaceChanges, inspectJjWorkingCopy } from "./get-workspace-changes";
import { getGitStdout } from "./git-utils";
import { runJjInWorkingCopy } from "./jj-utils";

export interface InspectReviewWorkspaceInput {
	cwd: string;
	baseRef: string;
	baseResolutionCwd?: string;
}

export interface ReviewWorkspaceInspection {
	vcs: "git" | "jj";
	changes: RuntimeWorkspaceChangesResponse;
	receipt: RuntimeTaskWorkspaceReceipt;
}

function digestState(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function inspectGitWorkspace(input: InspectReviewWorkspaceInput): Promise<ReviewWorkspaceInspection> {
	const repoRoot = (await getGitStdout(["rev-parse", "--show-toplevel"], input.cwd)).trim();
	if (!repoRoot) throw new Error("Could not resolve git task workspace root.");
	const baseResolutionCwd = input.baseResolutionCwd ?? repoRoot;
	const [headCommit, baseCommit, status, untracked, conflicts, changes] = await Promise.all([
		getGitStdout(["rev-parse", "--verify", "HEAD"], repoRoot),
		getGitStdout(["rev-parse", "--verify", `${input.baseRef}^{commit}`], baseResolutionCwd),
		getGitStdout(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repoRoot),
		getGitStdout(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot),
		getGitStdout(["ls-files", "-u", "-z"], repoRoot),
		getWorkspaceChanges(repoRoot),
	]);
	const normalizedHead = headCommit.trim();
	const normalizedBase = baseCommit.trim();
	const hasUntracked = untracked.length > 0;
	const hasConflicts = conflicts.length > 0;
	const divergent = normalizedHead !== normalizedBase;
	const clean = status.length === 0 && !hasUntracked && !hasConflicts && !divergent;
	return {
		vcs: "git",
		changes,
		receipt: {
			vcs: "git",
			clean,
			headCommit: normalizedHead,
			baseCommit: normalizedBase,
			hasConflicts,
			hasUntracked,
			divergent,
			stateDigest: digestState({
				vcs: "git",
				headCommit: normalizedHead,
				baseCommit: normalizedBase,
				status,
				untracked,
				conflicts,
			}),
		},
	};
}

async function resolveJjBaseCommit(input: InspectReviewWorkspaceInput): Promise<string | null> {
	if (input.baseRef === "@") return null;
	if (/^[0-9a-f]{40,64}$/u.test(input.baseRef)) return input.baseRef;
	const result = await runJjInWorkingCopy(input.baseResolutionCwd ?? input.cwd, [
		"--ignore-working-copy",
		"log",
		"--no-graph",
		"-r",
		input.baseRef,
		"-T",
		"commit_id",
	]);
	if (!result.ok || !result.stdout) {
		throw new Error(result.stderr || `Could not resolve jj base revision "${input.baseRef}".`);
	}
	return result.stdout;
}

async function inspectJjWorkspace(input: InspectReviewWorkspaceInput): Promise<ReviewWorkspaceInspection> {
	let changes = await getJjWorkspaceChanges(input.cwd);
	let identity = await inspectJjWorkingCopy(input.cwd);
	if (changes.stateKey !== identity.stateKey) {
		changes = await getJjWorkspaceChanges(input.cwd);
		identity = await inspectJjWorkingCopy(input.cwd);
	}
	if (changes.stateKey !== identity.stateKey) {
		throw new Error("jj working-copy state changed while the Review receipt was being captured.");
	}
	const resolvedBaseCommit = await resolveJjBaseCommit(input);
	const parentCommit = identity.parentCommitIds.length === 1 ? identity.parentCommitIds[0] : undefined;
	const baseCommit = resolvedBaseCommit ?? parentCommit;
	if (!baseCommit) {
		throw new Error("jj task workspace has no single base commit for a Review receipt.");
	}
	const divergent =
		identity.parentCommitIds.length !== 1 ||
		(resolvedBaseCommit !== null && identity.parentCommitIds[0] !== resolvedBaseCommit);
	const clean = changes.files.length === 0 && !identity.hasConflicts && !divergent;
	return {
		vcs: "jj",
		changes,
		receipt: {
			vcs: "jj",
			clean,
			changeId: identity.changeId,
			commitId: identity.commitId,
			parentCommitIds: identity.parentCommitIds,
			baseCommit,
			hasConflicts: identity.hasConflicts,
			divergent,
			stateDigest: digestState({
				vcs: "jj",
				changeId: identity.changeId,
				commitId: identity.commitId,
				parentCommitIds: identity.parentCommitIds,
				baseCommit,
				hasConflicts: identity.hasConflicts,
				conflicts: identity.conflicts,
				summary: identity.summary,
			}),
		},
	};
}

export async function inspectReviewWorkspace(input: InspectReviewWorkspaceInput): Promise<ReviewWorkspaceInspection> {
	const vcs = detectRepositoryKind(input.cwd);
	if (vcs === "git") return inspectGitWorkspace(input);
	if (vcs === "jj") return inspectJjWorkspace(input);
	throw new Error(`Task workspace is not a recognized Git or jj repository: ${input.cwd}`);
}
