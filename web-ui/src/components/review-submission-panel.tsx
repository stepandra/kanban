import { CheckCircle2, FileText, GitCompareArrows, ShieldAlert } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { RuntimeTaskReviewSubmission } from "@/runtime/types";
import type { BoardCard } from "@/types";

function isVerifiedCleanSubmission(submission: RuntimeTaskReviewSubmission): boolean {
	const receipt = submission.receipt;
	return (
		submission.deliverableKind === "read_only_report" &&
		receipt.clean &&
		!receipt.hasConflicts &&
		!receipt.divergent &&
		(receipt.vcs !== "git" || !receipt.hasUntracked)
	);
}

function ReceiptDetails({ submission }: { submission: RuntimeTaskReviewSubmission }): React.ReactElement {
	const receipt = submission.receipt;
	return (
		<dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
			<div>
				<dt className="text-text-tertiary">VCS identity</dt>
				<dd className="mt-0.5 break-all font-mono text-text-primary">
					{receipt.vcs === "git" ? receipt.headCommit : `${receipt.changeId} / ${receipt.commitId}`}
				</dd>
			</div>
			<div>
				<dt className="text-text-tertiary">Base commit</dt>
				<dd className="mt-0.5 break-all font-mono text-text-primary">{receipt.baseCommit}</dd>
			</div>
			{receipt.vcs === "jj" ? (
				<div className="sm:col-span-2">
					<dt className="text-text-tertiary">Exact @ parents</dt>
					<dd className="mt-0.5 break-all font-mono text-text-primary">
						{receipt.parentCommitIds.join(", ") || "None"}
					</dd>
				</div>
			) : null}
			<div className="sm:col-span-2">
				<dt className="text-text-tertiary">Stable state digest</dt>
				<dd className="mt-0.5 break-all font-mono text-text-primary">{receipt.stateDigest}</dd>
			</div>
		</dl>
	);
}

export function ReviewSubmissionPanel({ card }: { card: BoardCard }): React.ReactElement {
	const submission = card.submission;
	if (card.deliverableKind !== "read_only_report") {
		return (
			<section
				className="flex min-h-0 flex-1 items-center justify-center bg-surface-0 p-8"
				aria-label="Change Review"
			>
				<div className="max-w-md rounded-lg border border-border bg-surface-1 px-5 py-4">
					<div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
						<GitCompareArrows size={16} className="text-status-green" /> Change ready for review
					</div>
					<p className="mt-2 text-xs leading-5 text-text-secondary">
						Inspect the workspace changes and verify the remote revision before archiving this task.
					</p>
				</div>
			</section>
		);
	}
	if (!submission) {
		return (
			<section
				className="flex min-h-0 flex-1 items-center justify-center bg-surface-0 p-8"
				aria-label="Review report"
			>
				<div className="max-w-md rounded-lg border border-status-orange/40 bg-status-orange/10 px-5 py-4 text-center text-sm font-medium text-status-orange">
					Durable submission missing — resubmit required
				</div>
			</section>
		);
	}

	const receiptVerified = isVerifiedCleanSubmission(submission);
	return (
		<section
			className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-0"
			aria-label="Durable Review submission"
		>
			<header className="shrink-0 border-b border-border bg-surface-1 px-4 py-3">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
							<FileText size={16} /> Durable Review report
						</div>
						<p className="mt-1 text-xs text-text-secondary">
							{submission.deliverableKind} · submitted {new Date(submission.submittedAt).toLocaleString()}
						</p>
					</div>
					<div className="flex items-center gap-1.5 text-xs text-status-orange">
						<ShieldAlert size={14} /> Acceptance unavailable — remains in Review
					</div>
				</div>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<div className="mb-4 grid gap-3 rounded-lg border border-border bg-surface-1 p-3 text-xs">
					<div className="flex items-center gap-2 font-medium text-text-primary">
						<CheckCircle2 size={14} className={receiptVerified ? "text-status-green" : "text-status-orange"} />
						{receiptVerified ? "No-change receipt verified" : "Receipt is not a verified clean no-change receipt"}
					</div>
					<dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
						<div>
							<dt className="text-text-tertiary">Report digest</dt>
							<dd className="mt-0.5 break-all font-mono text-text-primary">{submission.reportDigest}</dd>
						</div>
						<div>
							<dt className="text-text-tertiary">Task generation / attempt</dt>
							<dd className="mt-0.5 font-mono text-text-primary">
								{submission.generation} / {submission.executionAttemptId ?? "legacy-no-attempt"}
							</dd>
						</div>
						<div className="sm:col-span-2">
							<dt className="text-text-tertiary">Workspace snapshot</dt>
							<dd className="mt-0.5 break-all font-mono text-text-primary">
								{submission.workspace.path} · {submission.workspace.vcs} · {submission.workspace.baseRef}
							</dd>
						</div>
					</dl>
					<ReceiptDetails submission={submission} />
				</div>
				<article className="kb-markdown rounded-lg border border-border bg-surface-1 p-5 text-sm leading-6 text-text-primary">
					<ReactMarkdown remarkPlugins={[remarkGfm]}>{submission.reportMarkdown}</ReactMarkdown>
				</article>
			</div>
		</section>
	);
}
