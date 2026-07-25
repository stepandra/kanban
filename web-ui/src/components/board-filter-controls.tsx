import { Search } from "lucide-react";
import { useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeTaskSessionState } from "@/runtime/types";

export interface BoardAgentFilterOption {
	value: string;
	label: string;
}

const SESSION_STATE_OPTIONS: { value: RuntimeTaskSessionState; label: string }[] = [
	{ value: "idle", label: "Idle" },
	{ value: "running", label: "Running" },
	{ value: "awaiting_review", label: "Waiting for review" },
	{ value: "failed", label: "Failed" },
	{ value: "interrupted", label: "Interrupted" },
];

export function BoardFilterControls({
	query,
	onQueryChange,
	agentId,
	onAgentIdChange,
	sessionState,
	onSessionStateChange,
	agentOptions,
	isBoardActive,
}: {
	query: string;
	onQueryChange: (query: string) => void;
	agentId: string | null;
	onAgentIdChange: (agentId: string | null) => void;
	sessionState: RuntimeTaskSessionState | null;
	onSessionStateChange: (sessionState: RuntimeTaskSessionState | null) => void;
	agentOptions: BoardAgentFilterOption[];
	isBoardActive: boolean;
}): React.ReactElement {
	const searchInputRef = useRef<HTMLInputElement>(null);

	useHotkeys(
		"/",
		() => {
			searchInputRef.current?.focus();
			searchInputRef.current?.select();
		},
		// useKey so "/" matches event.key (the code-based matcher never maps Slash to "/").
		{ enabled: isBoardActive, enableOnFormTags: false, preventDefault: true, useKey: true },
		[],
	);

	return (
		<div className="flex min-w-0 items-center gap-2">
			<div className="relative">
				<Search
					size={14}
					aria-hidden
					className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary"
				/>
				<input
					ref={searchInputRef}
					type="text"
					value={query}
					onChange={(event) => onQueryChange(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key !== "Escape") {
							return;
						}
						event.preventDefault();
						event.stopPropagation();
						if (query) {
							onQueryChange("");
							return;
						}
						event.currentTarget.blur();
					}}
					placeholder="Filter tasks…  ( / )"
					aria-label="Filter tasks"
					className="h-7 w-48 rounded-md border border-border-bright bg-surface-2 pl-7 pr-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
				/>
			</div>
			<NativeSelect
				size="sm"
				value={agentId ?? "all"}
				onChange={(event) =>
					onAgentIdChange(event.currentTarget.value === "all" ? null : event.currentTarget.value)
				}
				aria-label="Filter by agent"
			>
				<option value="all">All agents</option>
				{agentOptions.map((option) => (
					<option key={option.value === "" ? "__default__" : option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</NativeSelect>
			<NativeSelect
				size="sm"
				value={sessionState ?? "all"}
				onChange={(event) =>
					onSessionStateChange(
						event.currentTarget.value === "all" ? null : (event.currentTarget.value as RuntimeTaskSessionState),
					)
				}
				aria-label="Filter by session state"
			>
				<option value="all">All states</option>
				{SESSION_STATE_OPTIONS.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</NativeSelect>
		</div>
	);
}
