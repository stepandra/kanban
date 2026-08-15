import { createHash } from "node:crypto";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskAcceptanceEvidence,
	RuntimeTaskReviewSubmission,
	RuntimeTaskWorkspaceReceipt,
} from "../core/api-contract";
import { runtimeTaskAcceptRequestSchema, runtimeTaskReviewSubmissionSchema } from "../core/api-contract";
import { acceptTask } from "../core/task-board-mutations";
import { resolveTaskGeneration } from "../core/task-execution-reference";
import { loadWorkspaceBoardById, loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import { inspectReviewWorkspace } from "./review-workspace-receipt";
import { getTaskWorkspacePathInfo } from "./task-worktree";

interface TaskRecord {
	task: RuntimeBoardCard;
	columnId: RuntimeBoardColumnId;
}

type LocalAcceptanceEvidence = Exclude<RuntimeTaskAcceptanceEvidence, { kind: "verified_remote_revision" }>;

export interface AcceptTaskInput {
	workspaceRepoPath: string;
	taskId: string;
	architectThreadId: string;
}

export interface AcceptedTask {
	task: RuntimeBoardCard;
	evidence: LocalAcceptanceEvidence;
}

function findTask(board: RuntimeBoardData, taskId: string): TaskRecord | null {
	for (const column of board.columns) {
		const task = column.cards.find((candidate) => candidate.id === taskId);
		if (task) return { task, columnId: column.id };
	}
	return null;
}

function assertReviewCandidate(record: TaskRecord, taskId: string, architectThreadId: string): void {
	if (record.columnId !== "review") {
		throw new Error(`Task "${taskId}" must be in Review before acceptance.`);
	}
	if (!record.task.origin) {
		throw new Error(`Task "${taskId}" has no immutable Amp Architect origin.`);
	}
	if (record.task.origin.threadId !== architectThreadId) {
		throw new Error("Acceptance must come from the task's Amp Architect origin thread.");
	}
}

function assertCurrentTaskFence(record: TaskRecord, generation: number, executionAttemptId: string | null): void {
	if (
		resolveTaskGeneration(record.task.generation) !== generation ||
		(record.task.execution?.attemptId ?? null) !== executionAttemptId ||
		(record.task.execution !== undefined && record.task.execution.generation !== generation)
	) {
		throw new Error("Acceptance evidence is stale for the current task generation or attempt.");
	}
}

function assertWorkspaceReceiptIsConflictFree(receipt: RuntimeTaskWorkspaceReceipt): void {
	if (receipt.hasConflicts) {
		throw new Error("The task workspace has conflicts and cannot be accepted.");
	}
}

function assertReadOnlyWorkspaceReceiptIsClean(receipt: RuntimeTaskWorkspaceReceipt): void {
	if (!receipt.clean || receipt.divergent || (receipt.vcs === "git" && receipt.hasUntracked)) {
		throw new Error("The task workspace no longer has a verified-clean no-change state.");
	}
}

function assertWorkspaceIdentityMatchesSubmission(
	inspection: Awaited<ReturnType<typeof inspectReviewWorkspace>>,
	submission: RuntimeTaskReviewSubmission,
): void {
	if (
		inspection.vcs !== submission.workspace.vcs ||
		JSON.stringify(inspection.receipt) !== JSON.stringify(submission.receipt)
	) {
		throw new Error("The reverified workspace identity does not match the immutable Review receipt.");
	}
}

function createReadOnlyEvidence(input: {
	taskId: string;
	architectThreadId: string;
	submission: RuntimeTaskReviewSubmission;
	receipt: RuntimeTaskWorkspaceReceipt;
}): Extract<RuntimeTaskAcceptanceEvidence, { kind: "verified_no_change_report" }> {
	return {
		kind: "verified_no_change_report",
		taskId: input.taskId,
		generation: input.submission.generation,
		executionAttemptId: input.submission.executionAttemptId,
		reportDigest: input.submission.reportDigest,
		receipt: input.receipt,
		architectThreadId: input.architectThreadId,
		verifiedAt: Date.now(),
	};
}

function createChangeEvidence(input: {
	task: RuntimeBoardCard;
	workspacePath: string;
	vcs: "git" | "jj";
	receipt: RuntimeTaskWorkspaceReceipt;
	architectThreadId: string;
}): Extract<RuntimeTaskAcceptanceEvidence, { kind: "verified_local_workspace" }> {
	return {
		kind: "verified_local_workspace",
		taskId: input.task.id,
		generation: resolveTaskGeneration(input.task.generation),
		executionAttemptId: input.task.execution?.attemptId ?? null,
		workspace: {
			taskId: input.task.id,
			path: input.workspacePath,
			vcs: input.vcs,
			baseRef: input.task.baseRef,
		},
		receipt: input.receipt,
		architectThreadId: input.architectThreadId,
		verifiedAt: Date.now(),
	};
}

export async function acceptTaskFromTrustedLocalControlPlane(input: AcceptTaskInput): Promise<AcceptedTask> {
	const parsedRequest = runtimeTaskAcceptRequestSchema.safeParse({
		taskId: input.taskId,
		architectThreadId: input.architectThreadId,
	});
	if (!parsedRequest.success) {
		throw new Error(parsedRequest.error.issues[0]?.message ?? "Invalid task acceptance request.");
	}
	const { taskId, architectThreadId } = parsedRequest.data;

	const context = await loadWorkspaceContext(input.workspaceRepoPath, { autoCreateIfMissing: false });
	const initialBoard = await loadWorkspaceBoardById(context.workspaceId);
	const initialRecord = findTask(initialBoard, taskId);
	if (!initialRecord) throw new Error(`Task "${taskId}" was not found in workspace ${context.repoPath}.`);
	assertReviewCandidate(initialRecord, taskId, architectThreadId);

	const initialGeneration = resolveTaskGeneration(initialRecord.task.generation);
	const initialExecutionAttemptId = initialRecord.task.execution?.attemptId ?? null;
	assertCurrentTaskFence(initialRecord, initialGeneration, initialExecutionAttemptId);

	const taskWorkspace = await getTaskWorkspacePathInfo({
		cwd: context.repoPath,
		taskId,
		baseRef: initialRecord.task.baseRef,
	});
	if (!taskWorkspace.exists) {
		throw new Error(`Task workspace is missing: ${taskWorkspace.path}`);
	}

	const inspection = await inspectReviewWorkspace({
		cwd: taskWorkspace.path,
		baseRef: initialRecord.task.baseRef,
		baseResolutionCwd: context.repoPath,
	});

	let expectedSubmission: RuntimeTaskReviewSubmission | null = null;
	let evidence: LocalAcceptanceEvidence;
	if ((initialRecord.task.deliverableKind ?? "change") === "read_only_report") {
		if (!initialRecord.task.submission) {
			throw new Error(`Task "${taskId}" has no durable Review submission.`);
		}
		const submission = runtimeTaskReviewSubmissionSchema.parse(initialRecord.task.submission);
		const computedDigest = createHash("sha256").update(submission.reportMarkdown).digest("hex");
		if (computedDigest !== submission.reportDigest) {
			throw new Error("The durable Review report digest is invalid.");
		}
		if (taskWorkspace.path !== submission.workspace.path || initialRecord.task.baseRef !== submission.workspace.baseRef) {
			throw new Error("The task workspace no longer matches the immutable Review submission.");
		}
		assertCurrentTaskFence(initialRecord, submission.generation, submission.executionAttemptId);
		assertReadOnlyWorkspaceReceiptIsClean(inspection.receipt);
		assertWorkspaceIdentityMatchesSubmission(inspection, submission);
		expectedSubmission = submission;
		evidence = createReadOnlyEvidence({ taskId, architectThreadId, submission, receipt: inspection.receipt });
	} else {
		assertWorkspaceReceiptIsConflictFree(inspection.receipt);
		evidence = createChangeEvidence({
			task: initialRecord.task,
			workspacePath: taskWorkspace.path,
			vcs: inspection.vcs,
			receipt: inspection.receipt,
			architectThreadId,
		});
	}

	const mutation = await mutateWorkspaceState(context.repoPath, async (latestState) => {
		const latestRecord = findTask(latestState.board, taskId);
		if (!latestRecord) throw new Error(`Task "${taskId}" disappeared during acceptance verification.`);
		assertReviewCandidate(latestRecord, taskId, architectThreadId);
		assertCurrentTaskFence(latestRecord, initialGeneration, initialExecutionAttemptId);
		if (latestRecord.task.baseRef !== initialRecord.task.baseRef) {
			throw new Error("The task base identity changed during acceptance verification.");
		}
		if ((latestRecord.task.deliverableKind ?? "change") !== (initialRecord.task.deliverableKind ?? "change")) {
			throw new Error("The task deliverable changed during acceptance verification.");
		}
		if (expectedSubmission) {
			const latestSubmission = runtimeTaskReviewSubmissionSchema.parse(latestRecord.task.submission);
			if (JSON.stringify(latestSubmission) !== JSON.stringify(expectedSubmission)) {
				throw new Error("The immutable Review submission changed during acceptance verification.");
			}
		}
		const finalInspection = await inspectReviewWorkspace({
			cwd: taskWorkspace.path,
			baseRef: latestRecord.task.baseRef,
			baseResolutionCwd: context.repoPath,
		});
		assertWorkspaceReceiptIsConflictFree(finalInspection.receipt);
		if (JSON.stringify(finalInspection.receipt) !== JSON.stringify(inspection.receipt)) {
			throw new Error("The task workspace changed during acceptance verification.");
		}
		const accepted = acceptTask(latestState.board, taskId, evidence);
		if (!accepted.task) throw new Error(`Task "${taskId}" could not be accepted.`);
		return { board: accepted.board, value: accepted.task };
	});

	return { task: mutation.value, evidence };
}
