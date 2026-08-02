import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { CircleCheck, CircleX, RefreshCw, ScrollText } from "lucide-react";
import { useCallback, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeWorkerCommandLogEntry, RuntimeWorkerCommandLogResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { BoardData } from "@/types";
import { useInterval } from "@/utils/react-use";

const COMMAND_LOG_REFRESH_INTERVAL_MS = 2_000;

function quoteCommandArgument(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatCommand(command: readonly string[]): string {
	return command.map(quoteCommandArgument).join(" ");
}

function formatStartedAt(value: number): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(new Date(value));
}

function buildTaskTitleById(board: BoardData): ReadonlyMap<string, string> {
	const entries = board.columns.flatMap((column) => column.cards.map((card) => [card.id, card.title] as const));
	return new Map(entries);
}

function CommandLogRow({
	entry,
	taskTitle,
	onSelectTask,
}: {
	entry: RuntimeWorkerCommandLogEntry;
	taskTitle: string | undefined;
	onSelectTask: (taskId: string) => void;
}): React.ReactElement {
	const agentLabel = getRuntimeAgentCatalogEntry(entry.agentId)?.label ?? entry.agentId;
	const isStarted = entry.status === "started";

	return (
		<li className="grid grid-cols-[76px_minmax(0,1fr)] gap-3 border-b border-border px-4 py-3 last:border-b-0">
			<div className="flex flex-col gap-1 pt-0.5 font-mono text-[11px] text-text-tertiary">
				<time dateTime={new Date(entry.startedAt).toISOString()}>{formatStartedAt(entry.startedAt)}</time>
				<span className={isStarted ? "text-status-green" : "text-status-red"}>
					{isStarted ? "STARTED" : "FAILED"}
				</span>
			</div>
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
					<span className="inline-flex items-center gap-1 font-medium text-text-primary">
						{isStarted ? (
							<CircleCheck size={13} className="text-status-green" />
						) : (
							<CircleX size={13} className="text-status-red" />
						)}
						{agentLabel}
					</span>
					<button
						type="button"
						className="max-w-full truncate text-left text-accent hover:text-accent-hover hover:underline"
						onClick={() => onSelectTask(entry.taskId)}
						title={taskTitle ?? entry.taskId}
					>
						{taskTitle ?? `Task ${entry.taskId}`}
					</button>
					{entry.pid !== null ? <span className="font-mono text-text-tertiary">pid {entry.pid}</span> : null}
				</div>
				<div className="mt-2 overflow-x-auto rounded-md border border-border bg-surface-0 px-3 py-2">
					<code className="block min-w-max whitespace-pre font-mono text-[11px] leading-5 text-text-secondary">
						{formatCommand(entry.command)}
					</code>
				</div>
				<p className="mt-1.5 mb-0 truncate font-mono text-[10px] text-text-tertiary" title={entry.cwd}>
					cwd · {entry.cwd}
				</p>
				{entry.error ? <p className="mt-1.5 mb-0 text-xs text-status-red">{entry.error}</p> : null}
			</div>
		</li>
	);
}

export function WorkerCommandLogDialog({
	open,
	onOpenChange,
	workspaceId,
	board,
	onSelectTask,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string | null;
	board: BoardData;
	onSelectTask: (taskId: string) => void;
}): React.ReactElement {
	const taskTitleById = useMemo(() => buildTaskTitleById(board), [board]);
	const queryFn = useCallback(async (): Promise<RuntimeWorkerCommandLogResponse> => {
		if (!workspaceId) {
			return { generatedAt: Date.now(), entries: [] };
		}
		return await getRuntimeTrpcClient(workspaceId).runtime.getWorkerCommandLog.query();
	}, [workspaceId]);
	const commandLogQuery = useTrpcQuery({
		enabled: open && workspaceId !== null,
		queryFn,
		retainDataOnError: true,
	});

	useInterval(
		() => {
			void commandLogQuery.refetch();
		},
		open && workspaceId !== null ? COMMAND_LOG_REFRESH_INTERVAL_MS : null,
	);

	const handleSelectTask = useCallback(
		(taskId: string) => {
			onOpenChange(false);
			onSelectTask(taskId);
		},
		[onOpenChange, onSelectTask],
	);
	const entries = commandLogQuery.data?.entries ?? [];

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
			contentAriaDescribedBy={undefined}
			contentClassName="h-[min(720px,85vh)] !max-w-5xl"
		>
			<DialogHeader title="Worker commands" icon={<ScrollText size={16} />}>
				<Button
					variant="ghost"
					size="sm"
					icon={commandLogQuery.isLoading ? <Spinner size={14} /> : <RefreshCw size={14} />}
					onClick={() => void commandLogQuery.refetch()}
					disabled={commandLogQuery.isLoading || workspaceId === null}
					aria-label="Refresh worker commands"
					className="ml-auto mr-1"
				/>
			</DialogHeader>
			<DialogBody className="flex flex-col p-0">
				<div className="flex items-center justify-between gap-4 border-b border-border px-4 py-2 text-[11px] text-text-tertiary">
					<span>Actual PTY launches for this runtime · newest first · up to 200</span>
					<span className="shrink-0">{entries.length} entries</span>
				</div>
				{commandLogQuery.error && entries.length === 0 ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-text-secondary">
						<CircleX size={28} className="text-status-red" />
						<p className="m-0">{commandLogQuery.error.message}</p>
						<Button onClick={() => void commandLogQuery.refetch()}>Retry</Button>
					</div>
				) : commandLogQuery.isLoading && commandLogQuery.data === null ? (
					<div className="flex flex-1 items-center justify-center">
						<Spinner size={24} />
					</div>
				) : entries.length === 0 ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
						<ScrollText size={30} className="text-text-tertiary" />
						<p className="m-0 text-sm text-text-primary">No worker commands in this runtime yet</p>
						<p className="m-0 max-w-md text-xs leading-5 text-text-tertiary">
							A row appears when Kanban attempts to launch a task worker. Prompts and sensitive command arguments
							are redacted.
						</p>
					</div>
				) : (
					<ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
						{entries.map((entry) => (
							<CommandLogRow
								key={entry.id}
								entry={entry}
								taskTitle={taskTitleById.get(entry.taskId)}
								onSelectTask={handleSelectTask}
							/>
						))}
					</ul>
				)}
			</DialogBody>
		</Dialog>
	);
}
