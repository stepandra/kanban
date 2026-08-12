import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { AlertTriangle, ArrowRight, Bot, GitBranch, Link2, ShieldCheck } from "lucide-react";

import { TaskOriginContext } from "@/components/task-origin-context";
import { cn } from "@/components/ui/cn";
import type { RuntimeTaskExecutionProjection } from "@/runtime/types";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { BoardDependency, CardSelection } from "@/types";

function compactId(value: string | null | undefined): string {
	if (!value) {
		return "Not available";
	}
	return value.length > 12 ? value.slice(0, 12) : value;
}

function hasValidNoChangeReceipt(selection: CardSelection): boolean {
	const submission = selection.card.submission;
	if (!submission || submission.deliverableKind !== "read_only_report") return false;
	const receipt = submission.receipt;
	return (
		receipt.clean && !receipt.hasConflicts && !receipt.divergent && (receipt.vcs !== "git" || !receipt.hasUntracked)
	);
}

export function TaskOperationalOverview({
	selection,
	execution,
	dependencies,
	onOpenJjChange,
}: {
	selection: CardSelection;
	execution?: RuntimeTaskExecutionProjection | null;
	dependencies: BoardDependency[];
	onOpenJjChange?: (taskId: string) => void;
}): React.ReactElement {
	const workspace = useTaskWorkspaceSnapshotValue(selection.card.id);
	const cardRecords = selection.allColumns.flatMap((column) =>
		column.cards.map((card) => ({ card, columnId: column.id })),
	);
	const prerequisites = dependencies
		.filter((dependency) => dependency.fromTaskId === selection.card.id)
		.flatMap((dependency) => {
			const record = cardRecords.find(({ card }) => card.id === dependency.toTaskId);
			return record ? [record] : [];
		});
	const blockingPrerequisites = prerequisites.filter(({ columnId }) => columnId !== "trash");
	const generation = selection.card.generation ?? 1;
	const isStaleAttempt = execution ? execution.generation !== generation : false;
	const agentLabel =
		getRuntimeAgentCatalogEntry(selection.card.agentId ?? "codex")?.label ??
		selection.card.agentId ??
		"Default worker";
	const isReview = selection.column.id === "review";
	const isReadOnlyReview = isReview && selection.card.deliverableKind === "read_only_report";
	const reviewReceiptValid = hasValidNoChangeReceipt(selection);
	const status = isReview
		? !isReadOnlyReview
			? "Ready for review"
			: selection.card.submission
				? reviewReceiptValid
					? "Ready for review"
					: "Receipt invalid"
				: "Submission required"
		: isStaleAttempt
			? "stale"
			: (execution?.status ?? (selection.card.execution ? "checking" : "not queued"));
	const acceptanceEvidence = selection.card.acceptanceEvidence;

	return (
		<section
			className="shrink-0 border-b border-border bg-surface-1 px-4 py-3"
			aria-label="Task operational overview"
		>
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-tertiary">
						<span>{selection.column.title}</span>
						<ArrowRight size={11} />
						<span>Generation {generation}</span>
					</div>
					<h1 className="truncate text-base font-semibold text-text-primary">{selection.card.title}</h1>
					<p className="mt-1 line-clamp-2 max-w-3xl text-xs leading-5 text-text-secondary">
						{selection.card.prompt}
					</p>
				</div>
				<div
					className={cn(
						"shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
						(status === "running" || status === "Ready for review") &&
							"border-status-green/50 bg-status-green/10 text-status-green",
						status === "pending" && "border-status-blue/50 bg-status-blue/10 text-status-blue",
						(status === "failed" ||
							status === "cancelled" ||
							status === "stale" ||
							status === "Receipt invalid" ||
							status === "Submission required") &&
							"border-status-orange/50 bg-status-orange/10 text-status-orange",
						![
							"running",
							"pending",
							"failed",
							"cancelled",
							"stale",
							"Ready for review",
							"Receipt invalid",
							"Submission required",
						].includes(status) && "border-border-bright bg-surface-2 text-text-secondary",
					)}
				>
					{status}
				</div>
			</div>
			<div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
				<div className="rounded-md border border-border bg-surface-2 px-3 py-2">
					<div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-tertiary">
						<Bot size={12} /> Executor
					</div>
					<div className="mt-1 text-xs font-medium text-text-primary">{agentLabel}</div>
				</div>
				<button
					type="button"
					disabled={!workspace?.changeId || !onOpenJjChange}
					onClick={() => onOpenJjChange?.(selection.card.id)}
					className="rounded-md border border-border bg-surface-2 px-3 py-2 text-left transition-colors enabled:hover:border-status-purple/50 enabled:hover:bg-surface-3 disabled:cursor-default"
					title={workspace?.changeId ? "Open this task in the jj graph" : "No jj change is attached yet"}
				>
					<div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-tertiary">
						<GitBranch size={12} /> jj change
					</div>
					<div className="mt-1 font-mono text-xs text-text-primary">{compactId(workspace?.changeId)}</div>
				</button>
				<div className="rounded-md border border-border bg-surface-2 px-3 py-2">
					<div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-tertiary">
						<Link2 size={12} /> Dependencies
					</div>
					<div className="mt-1 text-xs text-text-primary">
						{blockingPrerequisites.length > 0
							? `${blockingPrerequisites.length} blocking`
							: prerequisites.length > 0
								? "Prerequisites complete"
								: "Ready"}
					</div>
				</div>
				<div className="rounded-md border border-border bg-surface-2 px-3 py-2">
					<div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-tertiary">
						{selection.column.id === "review" ? <ShieldCheck size={12} /> : <AlertTriangle size={12} />} Review
					</div>
					<div
						className="mt-1 text-xs text-text-primary"
						title={
							acceptanceEvidence?.kind === "verified_remote_revision"
								? acceptanceEvidence.acceptedRevision.remoteRef
								: undefined
						}
					>
						{acceptanceEvidence?.kind === "verified_no_change_report"
							? "No-change receipt verified"
							: acceptanceEvidence?.kind === "verified_remote_revision"
								? `${compactId(acceptanceEvidence.acceptedRevision.sha)} verified`
								: isReview && selection.card.deliverableKind === "read_only_report"
									? reviewReceiptValid
										? "No-change receipt verified"
										: "No-change receipt required"
									: isReview
										? "Remote proof required"
										: "Not accepted"}
					</div>
					{acceptanceEvidence?.kind === "verified_remote_revision" ? (
						<div className="mt-0.5 truncate font-mono text-[10px] text-text-tertiary">
							{acceptanceEvidence.acceptedRevision.remoteRef.replace("refs/heads/", "")}
						</div>
					) : isReview && selection.card.deliverableKind === "read_only_report" && reviewReceiptValid ? (
						<div className="mt-0.5 text-[10px] text-text-tertiary">
							Acceptance unavailable — remains in Review
						</div>
					) : null}
				</div>
			</div>
			{selection.card.origin ? (
				<div className="mt-2 overflow-hidden rounded-md border border-border">
					<TaskOriginContext origin={selection.card.origin} />
				</div>
			) : null}
		</section>
	);
}
