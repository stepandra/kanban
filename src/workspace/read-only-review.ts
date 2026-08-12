import { createHash } from "node:crypto";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskAcceptanceEvidence,
} from "../core/api-contract";
import { runtimeTaskReviewSubmissionSchema } from "../core/api-contract";
import { acceptReadOnlyTask } from "../core/task-board-mutations";
import { loadWorkspaceBoardById, loadWorkspaceContext } from "../state/workspace-state";
import { inspectReviewWorkspace } from "./review-workspace-receipt";
import { getTaskWorkspacePathInfo } from "./task-worktree";

interface TaskRecord {
	task: RuntimeBoardCard;
	columnId: RuntimeBoardColumnId;
}

export interface VerifyReadOnlyReviewInput {
	workspaceRepoPath: string;
	taskId: string;
}

export interface VerifiedReadOnlyReview {
	task: RuntimeBoardCard;
	evidence: Extract<RuntimeTaskAcceptanceEvidence, { kind: "verified_no_change_report" }>;
}

function findTask(board: RuntimeBoardData, taskId: string): TaskRecord | null {
	for (const column of board.columns) {
		const task = column.cards.find((candidate) => candidate.id === taskId);
		if (task) return { task, columnId: column.id };
	}
	return null;
}

function assertReviewCandidate(record: TaskRecord, taskId: string): string {
	if (record.columnId !== "review") {
		throw new Error(`Task "${taskId}" must be in Review before read-only acceptance.`);
	}
	if (record.task.deliverableKind !== "read_only_report") {
		throw new Error(`Task "${taskId}" is not an explicit read-only report deliverable.`);
	}
	if (!record.task.submission) {
		throw new Error(`Task "${taskId}" has no durable Review submission.`);
	}
	if (!record.task.origin) throw new Error("Read-only acceptance requires an immutable Amp Architect origin.");
	return record.task.origin.threadId;
}

/**
 * Re-verify every no-change acceptance fence without persisting a transition.
 * Kanban intentionally has no caller for this verifier until Amp can provide an
 * opaque, Kanban-verifiable actor capability for the current tool invocation.
 */
export async function verifyReadOnlyReviewForAcceptance(
	input: VerifyReadOnlyReviewInput,
): Promise<VerifiedReadOnlyReview> {
	const taskId = input.taskId.trim();
	if (!taskId) throw new Error("Task ID is required for read-only acceptance.");
	const context = await loadWorkspaceContext(input.workspaceRepoPath, { autoCreateIfMissing: false });
	const initialBoard = await loadWorkspaceBoardById(context.workspaceId);
	const initialRecord = findTask(initialBoard, taskId);
	if (!initialRecord) throw new Error(`Task "${taskId}" was not found in workspace ${context.repoPath}.`);
	const architectThreadId = assertReviewCandidate(initialRecord, taskId);
	const submission = runtimeTaskReviewSubmissionSchema.parse(initialRecord.task.submission);
	const computedDigest = createHash("sha256").update(submission.reportMarkdown).digest("hex");
	if (computedDigest !== submission.reportDigest) {
		throw new Error("The durable Review report digest is invalid.");
	}
	const taskWorkspace = await getTaskWorkspacePathInfo({
		cwd: context.repoPath,
		taskId,
		baseRef: initialRecord.task.baseRef,
	});
	if (!taskWorkspace.exists) {
		throw new Error(`Task workspace is missing: ${taskWorkspace.path}`);
	}
	if (taskWorkspace.path !== submission.workspace.path) {
		throw new Error("The task workspace path no longer matches the immutable Review submission.");
	}
	const inspected = await inspectReviewWorkspace({
		cwd: taskWorkspace.path,
		baseRef: initialRecord.task.baseRef,
		baseResolutionCwd: context.repoPath,
	});
	if (!inspected.receipt.clean || inspected.receipt.hasConflicts || inspected.receipt.divergent) {
		throw new Error("The task workspace no longer has a verified-clean no-change state.");
	}
	if (JSON.stringify(inspected.receipt) !== JSON.stringify(submission.receipt)) {
		throw new Error("The reverified workspace identity does not match the immutable Review receipt.");
	}

	const evidence: Extract<RuntimeTaskAcceptanceEvidence, { kind: "verified_no_change_report" }> = {
		kind: "verified_no_change_report",
		taskId,
		generation: submission.generation,
		executionAttemptId: submission.executionAttemptId,
		reportDigest: submission.reportDigest,
		receipt: inspected.receipt,
		architectThreadId,
		verifiedAt: Date.now(),
	};
	const latestBoard = await loadWorkspaceBoardById(context.workspaceId);
	const latestRecord = findTask(latestBoard, taskId);
	if (!latestRecord) throw new Error(`Task "${taskId}" disappeared during acceptance verification.`);
	const latestOriginThreadId = assertReviewCandidate(latestRecord, taskId);
	if (latestOriginThreadId !== architectThreadId) {
		throw new Error("The immutable Amp Architect origin changed during acceptance verification.");
	}
	const latestSubmission = runtimeTaskReviewSubmissionSchema.parse(latestRecord.task.submission);
	if (JSON.stringify(latestSubmission) !== JSON.stringify(submission)) {
		throw new Error("The immutable Review submission changed during acceptance verification.");
	}
	acceptReadOnlyTask(latestBoard, taskId, evidence);
	return { task: latestRecord.task, evidence };
}
