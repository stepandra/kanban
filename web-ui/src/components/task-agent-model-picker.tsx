import * as Collapsible from "@radix-ui/react-collapsible";
import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { ChevronDown } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeAgentId } from "@/runtime/types";

// ---------------------------------------------------------------------------
// Hook: builds the per-task agent override option list
// ---------------------------------------------------------------------------

export interface UseTaskAgentModelPickerInput {
	defaultAgentId?: RuntimeAgentId | null;
}

export interface UseTaskAgentModelPickerResult {
	agentOptions: Array<{ value: string; label: string }>;
}

export function useTaskAgentModelPicker({
	defaultAgentId,
}: UseTaskAgentModelPickerInput): UseTaskAgentModelPickerResult {
	const agentOptions = useMemo(() => {
		const catalog = getRuntimeLaunchSupportedAgentCatalog();
		let firstLabel = "Default";
		if (defaultAgentId) {
			const defaultAgent = catalog.find((a) => a.id === defaultAgentId);
			if (defaultAgent) {
				firstLabel = defaultAgent.label;
			}
		}
		return [
			{ value: "", label: firstLabel },
			// Exclude the default agent from the explicit list — it's already represented by the first option
			...catalog
				.filter((agent) => agent.id !== defaultAgentId)
				.map((agent) => ({ value: agent.id, label: agent.label })),
		];
	}, [defaultAgentId]);

	return {
		agentOptions,
	};
}

// ---------------------------------------------------------------------------
// Component: renders the per-task Agent override picker
// ---------------------------------------------------------------------------

export function TaskAgentModelPicker({
	agentId,
	onAgentIdChange,
	agentOptions,
}: {
	agentId: RuntimeAgentId | undefined;
	onAgentIdChange: (value: RuntimeAgentId | undefined) => void;
	agentOptions: Array<{ value: string; label: string }>;
}): ReactElement {
	const [isSettingsExpanded, setIsSettingsExpanded] = useState(false);

	return (
		<div className="flex flex-col gap-2">
			<Collapsible.Root open={isSettingsExpanded} onOpenChange={setIsSettingsExpanded}>
				<Collapsible.Trigger asChild>
					<button
						type="button"
						className="inline-flex w-fit items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer bg-transparent border-none p-0"
					>
						<ChevronDown
							size={12}
							className={cn("transition-transform", isSettingsExpanded ? "rotate-0" : "-rotate-90")}
						/>
						Override Agent Settings
					</button>
				</Collapsible.Trigger>
				<Collapsible.Content className="pt-2">
					<div className="flex flex-col gap-2">
						<div className="w-full sm:w-1/2 min-w-0">
							<span className="text-[11px] text-text-secondary block mb-1">Agent</span>
							<NativeSelect
								size="sm"
								fill
								value={agentId ?? ""}
								onChange={(e) => {
									const value = e.currentTarget.value;
									onAgentIdChange(value ? (value as RuntimeAgentId) : undefined);
								}}
							>
								{agentOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</NativeSelect>
						</div>
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		</div>
	);
}
