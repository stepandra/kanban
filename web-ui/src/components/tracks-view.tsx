import {
	AlertTriangle,
	ArrowRight,
	ChevronDown,
	ChevronRight,
	CircleDot,
	LayoutDashboard,
	RefreshCw,
	Route,
	SquareKanban,
	Waypoints,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { JjTaskLink } from "@/components/jj-history-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeMilestoneProjection,
	RuntimeTrackProgress,
	RuntimeTrackProjection,
	RuntimeTracksProjection,
	RuntimeTrackTaskCounts,
	RuntimeTrackTaskRef,
} from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

function formatProgress(progress: RuntimeTrackProgress): string {
	if (progress.percent === null) {
		return "Scope unset";
	}
	return `${progress.percent}%`;
}

function ProgressMeter({ progress }: { progress: RuntimeTrackProgress }): React.ReactElement {
	const percent = progress.percent ?? 0;
	return (
		<div className="flex min-w-[132px] items-center gap-2">
			<div
				className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-4"
				role="progressbar"
				aria-label="Track progress"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={progress.percent ?? undefined}
			>
				<div
					className={cn(
						"h-full rounded-full transition-[width] duration-300",
						progress.percent === null ? "bg-text-tertiary" : "bg-status-green",
					)}
					style={{ width: `${percent}%` }}
				/>
			</div>
			<span className="w-11 shrink-0 text-right font-mono text-[11px] text-text-primary">
				{formatProgress(progress)}
			</span>
		</div>
	);
}

function TaskCounts({ counts }: { counts: RuntimeTrackTaskCounts }): React.ReactElement {
	return (
		<div className="flex items-center gap-2.5 text-[11px] tabular-nums text-text-tertiary">
			<span title="Backlog">
				<span className="text-text-secondary">{counts.backlog}</span> queued
			</span>
			<span title="In progress">
				<span className="text-status-blue">{counts.inProgress}</span> active
			</span>
			<span title="In review">
				<span className="text-status-gold">{counts.review}</span> review
			</span>
			<span title="Accepted">
				<span className="text-status-green">{counts.accepted}</span> accepted
			</span>
		</div>
	);
}

const taskStatusLabel: Record<RuntimeTrackTaskRef["status"], string> = {
	backlog: "Backlog",
	in_progress: "In progress",
	review: "Review",
	accepted: "Accepted",
};

function TaskRow({
	task,
	hasJjChange,
	onSelectTask,
	onOpenTaskChange,
}: {
	task: RuntimeTrackTaskRef;
	hasJjChange: boolean;
	onSelectTask: (taskId: string) => void;
	onOpenTaskChange: (taskId: string) => void;
}): React.ReactElement {
	return (
		<div className="group grid min-h-9 grid-cols-[minmax(220px,1fr)_100px_86px_64px] items-center gap-3 border-t border-border/60 px-3 text-xs">
			<button
				type="button"
				onClick={() => onSelectTask(task.taskId)}
				className="flex min-w-0 items-center gap-2 text-left text-text-primary hover:text-accent focus:outline-none focus:ring-2 focus:ring-border-focus"
			>
				<SquareKanban size={12} className="shrink-0 text-text-tertiary" />
				<span className="truncate">{task.title}</span>
				<ArrowRight
					size={11}
					className="shrink-0 translate-x-[-2px] text-text-tertiary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
				/>
			</button>
			<span
				className={cn(
					"text-[11px]",
					task.status === "in_progress" && "text-status-blue",
					task.status === "review" && "text-status-gold",
					task.status === "accepted" && "text-status-green",
					task.status === "backlog" && "text-text-secondary",
				)}
			>
				{taskStatusLabel[task.status]}
			</span>
			<span className={task.blockedByCount > 0 ? "text-status-orange" : "text-text-tertiary"}>
				{task.blockedByCount > 0 ? `${task.blockedByCount} blocking` : "Ready"}
			</span>
			{hasJjChange ? (
				<button
					type="button"
					onClick={() => onOpenTaskChange(task.taskId)}
					className="inline-flex items-center justify-end gap-1 text-[11px] text-status-purple hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-border-focus"
					title="Open this task in the jj graph"
				>
					<Waypoints size={12} />
					jj
				</button>
			) : (
				<span className="text-right text-[11px] text-text-tertiary">no change</span>
			)}
		</div>
	);
}

function MilestoneRows({
	milestones,
	jjTaskIds,
	onSelectTask,
	onOpenTaskChange,
}: {
	milestones: RuntimeMilestoneProjection[];
	jjTaskIds: ReadonlySet<string>;
	onSelectTask: (taskId: string) => void;
	onOpenTaskChange: (taskId: string) => void;
}): React.ReactElement {
	return (
		<div className="border-t border-border bg-surface-0/50">
			{milestones.map((milestone) => (
				<section key={milestone.milestoneId} className="border-b border-border last:border-b-0">
					<div className="grid min-h-11 grid-cols-[minmax(220px,1fr)_150px_220px] items-center gap-4 px-3">
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<span className="truncate text-xs font-medium text-text-primary">{milestone.title}</span>
								<span
									className={cn(
										"rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
										milestone.state === "active" &&
											"border-status-blue/40 bg-status-blue/10 text-status-blue",
										milestone.state === "accepted" &&
											"border-status-green/40 bg-status-green/10 text-status-green",
										milestone.state === "planned" && "border-border text-text-tertiary",
										milestone.state === "archived" && "border-border text-text-tertiary opacity-70",
									)}
								>
									{milestone.state}
								</span>
							</div>
							{milestone.definitionOfDone ? (
								<p className="mt-0.5 mb-0 truncate text-[10px] text-text-tertiary">
									{milestone.definitionOfDone}
								</p>
							) : null}
						</div>
						<ProgressMeter progress={milestone.progress} />
						<TaskCounts counts={milestone.counts} />
					</div>
					{milestone.tasks.map((task) => (
						<TaskRow
							key={task.taskId}
							task={task}
							hasJjChange={jjTaskIds.has(task.taskId)}
							onSelectTask={onSelectTask}
							onOpenTaskChange={onOpenTaskChange}
						/>
					))}
				</section>
			))}
		</div>
	);
}

function TrackSection({
	track,
	expanded,
	jjTaskIds,
	onToggle,
	onSelectTask,
	onOpenTaskChange,
}: {
	track: RuntimeTrackProjection;
	expanded: boolean;
	jjTaskIds: ReadonlySet<string>;
	onToggle: () => void;
	onSelectTask: (taskId: string) => void;
	onOpenTaskChange: (taskId: string) => void;
}): React.ReactElement {
	const activeMilestone =
		track.milestones.find((milestone) => milestone.milestoneId === track.activeMilestoneId) ?? null;
	return (
		<section className={cn("border-b border-border", track.archived && "opacity-65")}>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				className="grid min-h-16 w-full grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)_150px_220px] items-center gap-4 px-4 text-left transition-colors hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-border-focus"
			>
				<div className="flex min-w-0 items-center gap-3">
					{expanded ? (
						<ChevronDown size={15} className="shrink-0 text-text-tertiary" />
					) : (
						<ChevronRight size={15} className="shrink-0 text-text-tertiary" />
					)}
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="m-0 truncate text-sm font-semibold text-text-primary">{track.name}</h2>
							{track.archived ? (
								<span className="text-[9px] font-semibold uppercase tracking-wide text-text-tertiary">
									Archived
								</span>
							) : null}
						</div>
						{track.description ? (
							<p className="mt-0.5 mb-0 truncate text-[11px] text-text-tertiary">{track.description}</p>
						) : null}
					</div>
				</div>
				<div className="min-w-0">
					<div className="text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
						Current milestone
					</div>
					<div className="mt-1 truncate text-xs text-text-primary">
						{activeMilestone?.title ?? "No active milestone"}
					</div>
				</div>
				<ProgressMeter progress={track.progress} />
				<TaskCounts counts={track.counts} />
			</button>
			{expanded ? (
				track.milestones.length > 0 ? (
					<MilestoneRows
						milestones={track.milestones}
						jjTaskIds={jjTaskIds}
						onSelectTask={onSelectTask}
						onOpenTaskChange={onOpenTaskChange}
					/>
				) : (
					<div className="border-t border-border bg-surface-0 px-12 py-3 text-xs text-text-tertiary">
						No milestones are defined for this track.
					</div>
				)
			) : null}
		</section>
	);
}

export function TracksViewContent({
	projection,
	jjTaskLinks,
	onSelectTask,
	onOpenTaskChange,
	onRefresh,
	onClose,
	isRefreshing = false,
}: {
	projection: RuntimeTracksProjection;
	jjTaskLinks: JjTaskLink[];
	onSelectTask: (taskId: string) => void;
	onOpenTaskChange: (taskId: string) => void;
	onRefresh: () => void;
	onClose: () => void;
	isRefreshing?: boolean;
}): React.ReactElement {
	const [expandedTrackIds, setExpandedTrackIds] = useState<ReadonlySet<string>>(
		() =>
			new Set(
				projection.tracks
					.filter((track) => track.activeMilestoneId !== null)
					.slice(0, 2)
					.map((track) => track.trackId),
			),
	);
	const jjTaskIds = useMemo(() => new Set(jjTaskLinks.map((task) => task.taskId)), [jjTaskLinks]);
	const activeTrackCount = projection.tracks.filter(
		(track) => track.activeMilestoneId !== null && !track.archived,
	).length;
	const blockedTaskCount = projection.tracks
		.flatMap((track) => track.milestones)
		.flatMap((milestone) => milestone.tasks)
		.filter((task) => task.blockedByCount > 0).length;

	const toggleTrack = (trackId: string): void => {
		setExpandedTrackIds((current) => {
			const next = new Set(current);
			if (next.has(trackId)) {
				next.delete(trackId);
			} else {
				next.add(trackId);
			}
			return next;
		});
	};

	return (
		<section className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0" aria-label="Delivery tracks">
			<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-4">
				<Route size={18} className="text-status-blue" />
				<div>
					<h1 className="m-0 text-sm font-semibold text-text-primary">Delivery tracks</h1>
					<p className="m-0 text-[11px] text-text-tertiary">
						Active milestone progress derived from accepted Kanban tasks
					</p>
				</div>
				<div className="ml-5 flex items-center gap-4 border-l border-border pl-5 text-[11px] text-text-tertiary">
					<span>
						<strong className="mr-1 text-text-primary">{activeTrackCount}</strong> active tracks
					</span>
					<span>
						<strong className="mr-1 text-text-primary">{projection.unassigned.tasks.length}</strong> unassigned
					</span>
					<span className={blockedTaskCount > 0 ? "text-status-orange" : undefined}>
						<strong className="mr-1 text-text-primary">{blockedTaskCount}</strong> blocked
					</span>
					<span className="font-mono">rev {projection.revision}</span>
				</div>
				<div className="ml-auto flex items-center gap-1.5">
					<Button
						size="sm"
						variant="ghost"
						icon={isRefreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
						disabled={isRefreshing}
						onClick={onRefresh}
					>
						Refresh
					</Button>
					<Button size="sm" icon={<LayoutDashboard size={13} />} onClick={onClose}>
						Board
					</Button>
				</div>
			</header>
			<div className="grid h-8 shrink-0 grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)_150px_220px] items-center gap-4 border-b border-border bg-surface-1/70 px-4 text-[10px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
				<span>Track</span>
				<span>Milestone</span>
				<span>Progress</span>
				<span>Task state</span>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{projection.tracks.length > 0 ? (
					projection.tracks.map((track) => (
						<TrackSection
							key={track.trackId}
							track={track}
							expanded={expandedTrackIds.has(track.trackId)}
							jjTaskIds={jjTaskIds}
							onToggle={() => toggleTrack(track.trackId)}
							onSelectTask={onSelectTask}
							onOpenTaskChange={onOpenTaskChange}
						/>
					))
				) : (
					<div className="flex min-h-52 items-center justify-center border-b border-border px-6 text-center">
						<div className="max-w-md">
							<Route size={30} className="mx-auto mb-3 text-text-tertiary" />
							<h2 className="m-0 text-sm font-semibold text-text-primary">No tracks are defined</h2>
							<p className="mt-1 mb-0 text-xs leading-5 text-text-secondary">
								This view only projects Kanban planning data. Define tracks and milestones through the
								authoritative Kanban planning workflow before assigning tasks.
							</p>
						</div>
					</div>
				)}
				{projection.unassigned.tasks.length > 0 ? (
					<section className="border-b border-border">
						<div className="flex min-h-12 items-center gap-3 px-4">
							<CircleDot size={14} className="text-text-tertiary" />
							<div>
								<h2 className="m-0 text-xs font-semibold text-text-primary">Unassigned scope</h2>
								<p className="m-0 text-[10px] text-text-tertiary">
									Tasks not yet mapped to a track and milestone
								</p>
							</div>
							<div className="ml-auto">
								<TaskCounts counts={projection.unassigned.counts} />
							</div>
						</div>
						{projection.unassigned.tasks.map((task) => (
							<TaskRow
								key={task.taskId}
								task={task}
								hasJjChange={jjTaskIds.has(task.taskId)}
								onSelectTask={onSelectTask}
								onOpenTaskChange={onOpenTaskChange}
							/>
						))}
					</section>
				) : null}
				{projection.crossTrackDependencies.length > 0 ? (
					<section className="px-4 py-4">
						<div className="mb-2 flex items-center gap-2">
							<AlertTriangle size={14} className="text-status-orange" />
							<h2 className="m-0 text-xs font-semibold text-text-primary">Cross-track blockers</h2>
						</div>
						<div className="grid gap-1">
							{projection.crossTrackDependencies.map((dependency) => (
								<div
									key={`${dependency.dependentTaskId}:${dependency.prerequisiteTaskId}`}
									className="flex items-center gap-2 border-l border-status-orange/50 py-1 pl-3 text-[11px] text-text-secondary"
								>
									<button
										type="button"
										onClick={() => onSelectTask(dependency.dependentTaskId)}
										className="font-mono text-text-primary hover:text-accent"
									>
										{dependency.dependentTaskId}
									</button>
									<span>in {dependency.dependentTrackId}</span>
									<ArrowRight size={11} />
									<span>waits on</span>
									<button
										type="button"
										onClick={() => onSelectTask(dependency.prerequisiteTaskId)}
										className="font-mono text-text-primary hover:text-accent"
									>
										{dependency.prerequisiteTaskId}
									</button>
									<span>in {dependency.prerequisiteTrackId}</span>
								</div>
							))}
						</div>
					</section>
				) : null}
			</div>
		</section>
	);
}

export function TracksView({
	workspaceId,
	workspaceRevision,
	jjTaskLinks,
	onSelectTask,
	onOpenTaskChange,
	onClose,
}: {
	workspaceId: string | null;
	workspaceRevision: number | null;
	jjTaskLinks: JjTaskLink[];
	onSelectTask: (taskId: string) => void;
	onOpenTaskChange: (taskId: string) => void;
	onClose: () => void;
}): React.ReactElement {
	const queryFn = useCallback(async (): Promise<RuntimeTracksProjection> => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		void workspaceRevision;
		return await getRuntimeTrpcClient(workspaceId).runtime.getTracksProjection.query();
	}, [workspaceId, workspaceRevision]);
	const tracksQuery = useTrpcQuery<RuntimeTracksProjection>({
		enabled: workspaceId !== null,
		queryFn,
		retainDataOnError: true,
	});

	if (tracksQuery.isLoading && !tracksQuery.data) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center bg-surface-0">
				<Spinner size={24} />
			</div>
		);
	}
	if (tracksQuery.error && !tracksQuery.data) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-surface-0 text-sm text-text-secondary">
				<Route size={30} className="text-text-tertiary" />
				<p className="m-0">{tracksQuery.error.message}</p>
				<div className="flex gap-2">
					<Button onClick={() => void tracksQuery.refetch()}>Retry</Button>
					<Button variant="ghost" onClick={onClose}>
						Board
					</Button>
				</div>
			</div>
		);
	}
	if (!tracksQuery.data) {
		return <div className="flex min-h-0 flex-1 bg-surface-0" />;
	}
	return (
		<TracksViewContent
			projection={tracksQuery.data}
			jjTaskLinks={jjTaskLinks}
			onSelectTask={onSelectTask}
			onOpenTaskChange={onOpenTaskChange}
			onRefresh={() => void tracksQuery.refetch()}
			onClose={onClose}
			isRefreshing={tracksQuery.isLoading}
		/>
	);
}
