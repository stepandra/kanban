import { Brain, ListChecks, MessageSquareText, Square, TerminalSquare, Wrench } from "lucide-react";
import type { FormEvent, ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAcpActivityItem, RuntimeTaskSessionSummary } from "@/runtime/types";

interface AcpActivityPanelProps {
	taskId: string;
	workspaceId: string | null;
	summary: RuntimeTaskSessionSummary;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onMoveToTrash?: () => void;
	isMoveToTrashLoading?: boolean;
	showMoveToTrash?: boolean;
}

const activityIcons: Record<RuntimeAcpActivityItem["kind"], ReactElement> = {
	message: <MessageSquareText size={14} />,
	thought: <Brain size={14} />,
	tool: <Wrench size={14} />,
	plan: <ListChecks size={14} />,
};

function activityLabel(activity: RuntimeAcpActivityItem): string {
	if (activity.kind !== "tool") {
		return activity.kind;
	}
	return activity.toolStatus ? `${activity.kind} · ${activity.toolStatus.replace("_", " ")}` : activity.kind;
}

export function AcpActivityPanel({
	taskId,
	workspaceId,
	summary,
	onSummary,
	onMoveToTrash,
	isMoveToTrashLoading = false,
	showMoveToTrash = false,
}: AcpActivityPanelProps): ReactElement {
	const [prompt, setPrompt] = useState("");
	const [isSending, setIsSending] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const activityEndRef = useRef<HTMLDivElement | null>(null);
	const activity = summary.acpActivity ?? [];
	const canInteract = summary.state === "running" || summary.state === "awaiting_review";

	useEffect(() => {
		activityEndRef.current?.scrollIntoView?.({ block: "end" });
	}, [activity.length]);

	const sendPrompt = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		const text = prompt.trim();
		if (!workspaceId || !text || isSending) {
			return;
		}
		setIsSending(true);
		setError(null);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).runtime.sendTaskSessionInput.mutate({
				taskId,
				text,
				appendNewline: true,
			});
			if (!response.ok || !response.summary) {
				throw new Error(response.error ?? "Could not send the ACP prompt.");
			}
			onSummary?.(response.summary);
			setPrompt("");
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setIsSending(false);
		}
	};

	const stopSession = async (): Promise<void> => {
		if (!workspaceId || isStopping) {
			return;
		}
		setIsStopping(true);
		setError(null);
		try {
			const response = await getRuntimeTrpcClient(workspaceId).runtime.stopTaskSession.mutate({ taskId });
			if (!response.ok || !response.summary) {
				throw new Error(response.error ?? "Could not stop the ACP session.");
			}
			onSummary?.(response.summary);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setIsStopping(false);
		}
	};

	return (
		<section className="flex min-h-0 flex-1 flex-col bg-surface-0" aria-label="Grok ACP activity">
			<header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-1 px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<TerminalSquare size={15} className="shrink-0 text-accent" />
					<div className="min-w-0">
						<div className="text-xs font-semibold text-text-primary">Grok ACP</div>
						<div className="truncate text-[11px] text-text-tertiary">
							{summary.mode === "plan" ? "Plan mode" : "Act mode"} · {summary.state.replace("_", " ")}
						</div>
					</div>
				</div>
				<Button
					variant="default"
					size="sm"
					icon={isStopping ? <Spinner size={14} /> : <Square size={13} />}
					disabled={!canInteract || isStopping}
					onClick={() => void stopSession()}
				>
					Stop
				</Button>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="acp-activity-list">
				{activity.length === 0 ? (
					<div className="flex h-full min-h-36 items-center justify-center text-center text-xs text-text-tertiary">
						Waiting for structured Grok activity…
					</div>
				) : (
					<div className="space-y-2">
						{activity.map((item) => (
							<div key={item.sequence} className="rounded-md border border-border bg-surface-1 px-3 py-2">
								<div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
									{activityIcons[item.kind]}
									<span>{activityLabel(item)}</span>
								</div>
								<div className="whitespace-pre-wrap break-words text-xs leading-5 text-text-primary">
									{item.text}
								</div>
								{item.plan && item.plan.length > 0 ? (
									<ul className="mt-2 space-y-1 text-[11px] text-text-secondary">
										{item.plan.map((entry, index) => (
											<li key={`${item.sequence}-${index}`} className="flex gap-2">
												<span className="w-16 shrink-0 text-text-tertiary">
													{entry.status.replace("_", " ")}
												</span>
												<span>{entry.content}</span>
											</li>
										))}
									</ul>
								) : null}
							</div>
						))}
						<div ref={activityEndRef} />
					</div>
				)}
			</div>

			{error ? (
				<div className="border-t border-status-red/30 bg-status-red/10 px-3 py-2 text-xs text-status-red">
					{error}
				</div>
			) : null}
			<form
				className="shrink-0 border-t border-border bg-surface-1 p-3"
				onSubmit={(event) => void sendPrompt(event)}
			>
				<div className="flex items-end gap-2">
					<textarea
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								event.currentTarget.form?.requestSubmit();
							}
						}}
						placeholder="Send a follow-up to Grok"
						aria-label="ACP prompt"
						rows={2}
						disabled={!canInteract || isSending}
						className="min-h-16 flex-1 resize-none rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
					/>
					<Button variant="primary" size="sm" disabled={!canInteract || !prompt.trim() || isSending}>
						{isSending ? <Spinner size={14} /> : "Send"}
					</Button>
				</div>
				<p className="mt-1.5 text-[10px] text-text-tertiary">Enter sends · Shift+Enter adds a line</p>
			</form>

			{showMoveToTrash && onMoveToTrash ? (
				<div className="shrink-0 border-t border-border bg-surface-1 p-3">
					<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
						{isMoveToTrashLoading ? <Spinner size={14} /> : "Discard Task"}
					</Button>
				</div>
			) : null}
		</section>
	);
}
