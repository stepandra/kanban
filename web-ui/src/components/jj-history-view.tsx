import { Bookmark, GitFork, LayoutDashboard, RefreshCw, SquareKanban, Waypoints, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeJjGraphNode, RuntimeJjGraphResponse, RuntimeTaskWorkspaceMetadata } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { BoardData } from "@/types";

export interface JjTaskLink {
	taskId: string;
	title: string;
	changeId: string;
}

export function buildJjTaskLinks(board: BoardData, taskWorkspaces: RuntimeTaskWorkspaceMetadata[]): JjTaskLink[] {
	const cardById = new Map(board.columns.flatMap((column) => column.cards).map((card) => [card.id, card]));
	return taskWorkspaces.flatMap((metadata) => {
		const card = cardById.get(metadata.taskId);
		if (!card || !metadata.exists || !metadata.changeId) {
			return [];
		}
		return [{ taskId: card.id, title: card.title, changeId: metadata.changeId }];
	});
}

interface TopologyNode {
	node: RuntimeJjGraphNode;
	lane: number;
}

function buildTopology(nodes: RuntimeJjGraphNode[]): { nodes: TopologyNode[]; laneCount: number } {
	const active: Array<string | null> = [];
	const topology: TopologyNode[] = [];
	for (const node of nodes) {
		let lane = active.indexOf(node.commitId);
		if (lane < 0) {
			lane = active.indexOf(null);
		}
		if (lane < 0) {
			lane = active.length;
			active.push(null);
		}
		topology.push({ node, lane });
		const [firstParent, ...otherParents] = node.parentCommitIds;
		active[lane] = firstParent ?? null;
		for (const parent of otherParents) {
			if (active.includes(parent)) {
				continue;
			}
			const freeLane = active.indexOf(null);
			if (freeLane >= 0) {
				active[freeLane] = parent;
			} else {
				active.push(parent);
			}
		}
	}
	return { nodes: topology, laneCount: Math.max(1, active.length) };
}

function selectOperationalNodes(nodes: RuntimeJjGraphNode[], taskLinks: JjTaskLink[]): RuntimeJjGraphNode[] {
	const byCommitId = new Map(nodes.map((node) => [node.commitId, node]));
	const selected = new Set(
		nodes
			.filter(
				(node) =>
					node.currentWorkingCopy ||
					node.workspaces.length > 0 ||
					node.bookmarks.length > 0 ||
					taskLinks.some((task) => task.changeId === node.changeId),
			)
			.map((node) => node.commitId),
	);
	const frontier = [...selected];
	while (frontier.length > 0 && selected.size < 48) {
		const commitId = frontier.shift();
		const node = commitId ? byCommitId.get(commitId) : null;
		for (const parentId of node?.parentCommitIds ?? []) {
			if (!selected.has(parentId) && byCommitId.has(parentId)) {
				selected.add(parentId);
				frontier.push(parentId);
			}
		}
	}
	const operational = nodes.filter((node) => selected.has(node.commitId));
	return operational.length > 0 ? operational.slice(0, 48) : nodes.slice(0, 32);
}

function TopologyCanvas({
	topology,
	selectedCommitId,
	onSelect,
}: {
	topology: ReturnType<typeof buildTopology>;
	selectedCommitId: string | null;
	onSelect: (commitId: string) => void;
}): React.ReactElement {
	const rowHeight = 58;
	const laneWidth = 20;
	const left = 16;
	const width = Math.max(56, topology.laneCount * laneWidth + 28);
	const indexByCommitId = new Map(topology.nodes.map(({ node }, index) => [node.commitId, index]));
	const laneByCommitId = new Map(topology.nodes.map(({ node, lane }) => [node.commitId, lane]));
	return (
		<div className="relative shrink-0" style={{ width, height: topology.nodes.length * rowHeight }}>
			<svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
				{topology.nodes.flatMap(({ node, lane }, rowIndex) =>
					node.parentCommitIds.flatMap((parentId) => {
						const parentIndex = indexByCommitId.get(parentId);
						if (parentIndex === undefined) {
							return [];
						}
						const parentLane = laneByCommitId.get(parentId) ?? lane;
						const x1 = left + lane * laneWidth;
						const y1 = rowIndex * rowHeight + rowHeight / 2;
						const x2 = left + parentLane * laneWidth;
						const y2 = parentIndex * rowHeight + rowHeight / 2;
						const midY = Math.min(y2 - 10, y1 + 18);
						return [
							<path
								key={`${node.commitId}-${parentId}`}
								d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
								fill="none"
								stroke="var(--color-status-purple)"
								strokeWidth="1.5"
								opacity="0.72"
							/>,
						];
					}),
				)}
				{topology.nodes.map(({ node, lane }, rowIndex) => (
					<circle
						key={node.commitId}
						cx={left + lane * laneWidth}
						cy={rowIndex * rowHeight + rowHeight / 2}
						r={node.currentWorkingCopy ? 6 : 4.5}
						fill={
							node.commitId === selectedCommitId
								? "var(--color-accent)"
								: node.currentWorkingCopy
									? "var(--color-status-purple)"
									: "var(--color-surface-1)"
						}
						stroke="var(--color-status-purple)"
						strokeWidth="2"
					/>
				))}
			</svg>
			{topology.nodes.map(({ node, lane }, rowIndex) => (
				<button
					key={node.commitId}
					type="button"
					aria-label={`Select change ${node.changeId}`}
					className="absolute z-10 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full focus:outline-none focus:ring-2 focus:ring-border-focus"
					style={{ left: left + lane * laneWidth, top: rowIndex * rowHeight + rowHeight / 2 }}
					onClick={() => onSelect(node.commitId)}
				/>
			))}
		</div>
	);
}

export function JjHistoryView({
	workspaceId,
	taskLinks,
	onSelectTask,
	onClose,
}: {
	workspaceId: string | null;
	taskLinks: JjTaskLink[];
	onSelectTask: (taskId: string) => void;
	onClose: () => void;
}): React.ReactElement {
	const [viewMode, setViewMode] = useState<"operational" | "all">("operational");
	const [selectedCommitId, setSelectedCommitId] = useState<string | null>(null);
	const queryFn = useCallback(async (): Promise<RuntimeJjGraphResponse> => {
		if (!workspaceId) {
			throw new Error("Missing workspace.");
		}
		return await getRuntimeTrpcClient(workspaceId).workspace.getJjGraph.query({ maxCount: 120 });
	}, [workspaceId]);
	const graphQuery = useTrpcQuery<RuntimeJjGraphResponse>({
		enabled: workspaceId !== null,
		queryFn,
		retainDataOnError: true,
	});
	const payload = graphQuery.data;
	const allNodes = useMemo(
		() => payload?.rows.flatMap((row) => (row.kind === "node" ? [row] : [])) ?? [],
		[payload?.rows],
	);
	const visibleNodes = useMemo(
		() => (viewMode === "all" ? allNodes.slice(0, 80) : selectOperationalNodes(allNodes, taskLinks)),
		[allNodes, taskLinks, viewMode],
	);
	const topology = useMemo(() => buildTopology(visibleNodes), [visibleNodes]);
	useEffect(() => {
		if (selectedCommitId && visibleNodes.some((node) => node.commitId === selectedCommitId)) {
			return;
		}
		setSelectedCommitId(
			visibleNodes.find((node) => node.currentWorkingCopy)?.commitId ??
				visibleNodes.find((node) => taskLinks.some((task) => task.changeId === node.changeId))?.commitId ??
				visibleNodes[0]?.commitId ??
				null,
		);
	}, [selectedCommitId, taskLinks, visibleNodes]);
	const selectedNode = visibleNodes.find((node) => node.commitId === selectedCommitId) ?? null;
	const selectedTaskLinks = taskLinks.filter((task) => task.changeId === selectedNode?.changeId);
	const errorMessage = graphQuery.error?.message ?? payload?.error ?? null;

	return (
		<section className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0" aria-label="Jujutsu change graph">
			<header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3">
				<Waypoints size={17} className="text-status-purple" />
				<div>
					<h2 className="m-0 text-sm font-semibold text-text-primary">Workspace topology</h2>
					<p className="m-0 text-[11px] text-text-tertiary">Tasks, jj changes, bookmarks, and working copies</p>
				</div>
				<div className="ml-4 flex rounded-md border border-border bg-surface-0 p-0.5">
					<button
						type="button"
						onClick={() => setViewMode("operational")}
						className={cn(
							"rounded px-2 py-1 text-[11px]",
							viewMode === "operational" ? "bg-surface-3 text-text-primary" : "text-text-secondary",
						)}
					>
						Operational
					</button>
					<button
						type="button"
						onClick={() => setViewMode("all")}
						className={cn(
							"rounded px-2 py-1 text-[11px]",
							viewMode === "all" ? "bg-surface-3 text-text-primary" : "text-text-secondary",
						)}
					>
						All history
					</button>
				</div>
				<div className="ml-auto flex items-center gap-1.5">
					<Button
						size="sm"
						variant="ghost"
						icon={graphQuery.isLoading ? <Spinner size={13} /> : <RefreshCw size={13} />}
						disabled={graphQuery.isLoading}
						onClick={() => void graphQuery.refetch()}
					>
						Refresh
					</Button>
					<Button size="sm" icon={<LayoutDashboard size={13} />} onClick={onClose}>
						Board
					</Button>
				</div>
			</header>
			{graphQuery.isLoading && !payload ? (
				<div className="flex flex-1 items-center justify-center"><Spinner size={24} /></div>
			) : errorMessage || payload?.ok === false ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-text-secondary">
					<Waypoints size={32} className="text-text-tertiary" />
					<p className="m-0">{errorMessage ?? "Could not read the jj graph."}</p>
				</div>
			) : (
				<div className="grid min-h-0 flex-1 grid-cols-[minmax(420px,1fr)_320px]">
					<div className="min-h-0 overflow-auto border-r border-border">
						<div className="flex min-w-[620px]">
							<TopologyCanvas topology={topology} selectedCommitId={selectedCommitId} onSelect={setSelectedCommitId} />
							<div className="min-w-0 flex-1">
								{topology.nodes.map(({ node }) => {
									const links = taskLinks.filter((task) => task.changeId === node.changeId);
									return (
										<button
											key={node.commitId}
											type="button"
											onClick={() => setSelectedCommitId(node.commitId)}
											className={cn(
												"flex h-[58px] w-full items-center gap-2 border-b border-border/60 px-2 text-left hover:bg-surface-1",
												node.commitId === selectedCommitId && "bg-surface-1",
											)}
										>
											<code className="w-[72px] shrink-0 font-mono text-[11px] text-status-purple">
												{node.changeId.slice(0, 8)}
											</code>
											<div className="min-w-0 flex-1">
												<div className="truncate text-[13px] text-text-primary">
													{node.description || "(no description)"}
												</div>
												<div className="mt-1 flex items-center gap-1.5 text-[10px] text-text-tertiary">
													{node.currentWorkingCopy ? <span className="text-status-purple">current</span> : null}
													{node.workspaces.length > 0 ? <span>{node.workspaces.join(", ")}</span> : null}
													{links.length > 0 ? <span className="text-status-blue">{links.length} task</span> : null}
													{node.conflict ? <span className="text-status-red">conflict</span> : null}
												</div>
											</div>
										</button>
									);
								})}
							</div>
						</div>
					</div>
					<aside className="min-h-0 overflow-auto bg-surface-1 p-4">
						{selectedNode ? (
							<>
								<div className="mb-4 flex items-center gap-2">
									<GitFork size={16} className="text-status-purple" />
									<span className="text-[11px] uppercase tracking-wide text-text-tertiary">Selected change</span>
								</div>
								<h3 className="m-0 text-sm font-semibold leading-5 text-text-primary">
									{selectedNode.description || "(no description)"}
								</h3>
								<dl className="mt-4 grid grid-cols-[72px_1fr] gap-x-3 gap-y-2 text-xs">
									<dt className="text-text-tertiary">Change</dt>
									<dd className="m-0 break-all font-mono text-status-purple">{selectedNode.changeId}</dd>
									<dt className="text-text-tertiary">Commit</dt>
									<dd className="m-0 break-all font-mono text-text-secondary">{selectedNode.commitId}</dd>
									<dt className="text-text-tertiary">Parents</dt>
									<dd className="m-0 font-mono text-text-secondary">
										{selectedNode.parentCommitIds.map((id) => id.slice(0, 10)).join(", ") || "root"}
									</dd>
								</dl>
								{selectedNode.bookmarks.length > 0 ? (
									<div className="mt-4 flex flex-wrap gap-1">
										{selectedNode.bookmarks.map((bookmark) => (
											<span key={bookmark} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs">
												<Bookmark size={11} /> {bookmark}
											</span>
										))}
									</div>
								) : null}
								<div className="mt-5 border-t border-border pt-4">
									<div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-text-tertiary">
										<SquareKanban size={13} /> Linked tasks
									</div>
									{selectedTaskLinks.length > 0 ? (
										<div className="grid gap-2">
											{selectedTaskLinks.map((task) => (
												<button
													key={task.taskId}
													type="button"
													onClick={() => onSelectTask(task.taskId)}
													className="rounded-md border border-status-blue/30 bg-status-blue/10 px-3 py-2 text-left text-xs text-status-blue hover:bg-status-blue/20"
												>
													{task.title}
												</button>
											))}
										</div>
									) : (
										<p className="m-0 text-xs text-text-tertiary">No Kanban task is attached to this change.</p>
									)}
								</div>
							</>
						) : (
							<div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-text-tertiary">
								<Workflow size={28} />
								Select a change to inspect its topology and task links.
							</div>
						)}
					</aside>
				</div>
			)}
		</section>
	);
}
