import { AlertTriangle, CircleDot, Eye, Route, Waypoints } from "lucide-react";

import { cn } from "@/components/ui/cn";
import type { RuntimeTaskExecutionProjection, RuntimeTaskSessionSummary, RuntimeVcsMode } from "@/runtime/types";
import type { BoardData } from "@/types";

interface BoardOperationalCounts {
	open: number;
	attached: number;
	review: number;
	attention: number;
}

export function getBoardOperationalCounts(
	data: BoardData,
	taskSessions: Record<string, RuntimeTaskSessionSummary>,
	executionProjections: Record<string, RuntimeTaskExecutionProjection> = {},
): BoardOperationalCounts {
	const openCards = data.columns.filter((column) => column.id !== "trash").flatMap((column) => column.cards);
	const review = data.columns.find((column) => column.id === "review")?.cards.length ?? 0;
	const attentionTaskIds = new Set<string>();
	let attached = 0;

	for (const card of openCards) {
		const sessionState = taskSessions[card.id]?.state;
		if (sessionState === "running") {
			attached += 1;
		}
		if (card.removedAgentId || sessionState === "failed" || sessionState === "interrupted") {
			attentionTaskIds.add(card.id);
		}
		const execution = executionProjections[card.id];
		if (
			execution &&
			(execution.generation !== (card.generation ?? 1) ||
				execution.status === "failed" ||
				execution.status === "cancelled" ||
				execution.status === "unknown")
		) {
			attentionTaskIds.add(card.id);
		}
	}

	return {
		open: openCards.length,
		attached,
		review,
		attention: attentionTaskIds.size,
	};
}

export function BoardOperationalSummary({
	data,
	taskSessions,
	executionProjections = {},
	workspaceVcs,
	onOpenTracksView,
	onOpenRepositoryView,
	onShowReview,
	onShowAttention,
	attentionActive = false,
}: {
	data: BoardData;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	executionProjections?: Record<string, RuntimeTaskExecutionProjection>;
	workspaceVcs?: RuntimeVcsMode | null;
	onOpenTracksView?: () => void;
	onOpenRepositoryView?: () => void;
	onShowReview?: () => void;
	onShowAttention?: () => void;
	attentionActive?: boolean;
}): React.ReactElement {
	const counts = getBoardOperationalCounts(data, taskSessions, executionProjections);

	return (
		<aside
			aria-label="Board operational summary"
			className="flex h-8 shrink-0 items-center overflow-hidden rounded-md border border-border bg-surface-1 text-xs text-text-secondary"
		>
			{onOpenTracksView ? (
				<button
					type="button"
					className="flex h-full items-center gap-1.5 border-r border-border px-2 font-medium text-text-primary transition-colors hover:bg-surface-3 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-border-focus"
					onClick={onOpenTracksView}
					title="Open delivery tracks"
				>
					<Route size={13} className="text-status-blue" />
					Tracks
				</button>
			) : null}
			{workspaceVcs === "jj" && onOpenRepositoryView ? (
				<button
					type="button"
					className="flex h-full items-center gap-1.5 border-r border-border px-2 font-medium text-text-primary transition-colors hover:bg-surface-3 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-border-focus"
					onClick={onOpenRepositoryView}
					title="Open the read-only jj change graph"
				>
					<Waypoints size={13} className="text-status-purple" />
					Jujutsu
				</button>
			) : workspaceVcs ? (
				<span className="flex h-full items-center gap-1.5 border-r border-border px-2 font-medium text-text-primary">
					<Waypoints size={13} className="text-status-purple" />
					{workspaceVcs === "jj" ? "Jujutsu" : "Git"}
				</span>
			) : null}
			<span className="flex items-center gap-1.5 px-2" title="Tasks outside the archive">
				<CircleDot size={12} className="text-status-blue" />
				<span className="font-semibold text-text-primary">{counts.open}</span>
				<span>open</span>
			</span>
			<span
				className="flex items-center gap-1.5 border-l border-border px-2"
				title="Task sessions currently attached to this Kanban runtime"
			>
				<span className="h-1.5 w-1.5 rounded-full bg-status-green" />
				<span className="font-semibold text-text-primary">{counts.attached}</span>
				<span>attached</span>
			</span>
			<button
				type="button"
				className="flex h-full items-center gap-1.5 border-l border-border px-2 hover:bg-surface-3"
				title="Show tasks awaiting review"
				onClick={onShowReview}
			>
				<Eye size={12} className="text-status-gold" />
				<span className="font-semibold text-text-primary">{counts.review}</span>
				<span>review</span>
			</button>
			<button
				type="button"
				className={cn(
					"flex h-full items-center gap-1.5 border-l border-border px-2 hover:bg-surface-3",
					attentionActive && "bg-surface-3",
				)}
				title="Failed, interrupted, or worker reassignment required"
				onClick={onShowAttention}
			>
				<AlertTriangle size={12} className={counts.attention > 0 ? "text-status-orange" : "text-text-tertiary"} />
				<span className="font-semibold text-text-primary">{counts.attention}</span>
				<span>attention</span>
			</button>
		</aside>
	);
}
