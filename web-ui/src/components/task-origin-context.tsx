import { Check, Copy, DraftingCompass } from "lucide-react";
import { useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeTaskOrigin } from "@/runtime/types";
import { copyTextToClipboard } from "@/utils/copy-to-clipboard";

export function buildAmpArchitectOpenCommand(threadId: string): string {
	return `amp threads continue ${threadId}`;
}

export function TaskOriginBadge({
	origin,
	muted = false,
}: {
	origin: RuntimeTaskOrigin;
	muted?: boolean;
}): React.ReactElement {
	return (
		<span
			className={cn(
				"inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
				muted
					? "border-border bg-surface-1 text-text-tertiary"
					: "border-status-purple/30 bg-status-purple/10 text-status-purple",
			)}
			title={`Created from Amp Architect thread ${origin.threadId}`}
		>
			<DraftingCompass size={12} className="shrink-0" />
			<span className="truncate">Amp Architect</span>
		</span>
	);
}

export function TaskOriginContext({ origin }: { origin: RuntimeTaskOrigin }): React.ReactElement {
	const [copied, setCopied] = useState(false);
	const command = buildAmpArchitectOpenCommand(origin.threadId);

	const handleCopy = async (): Promise<void> => {
		try {
			await copyTextToClipboard(command);
			setCopied(true);
			setTimeout(() => setCopied(false), 1_500);
		} catch {
			showAppToast(
				{
					intent: "warning",
					message: "Could not copy the Amp command. Select the thread reference and copy it manually.",
					timeout: 4_000,
				},
				"amp-architect-command-copy-failed",
			);
		}
	};

	return (
		<div className="flex min-w-0 items-center gap-2 border-b border-divider bg-surface-1 px-3 py-1.5">
			<DraftingCompass size={14} className="shrink-0 text-status-purple" />
			<div className="flex min-w-0 flex-1 items-baseline gap-2">
				<span className="text-xs font-medium text-text-primary">Origin · Amp Architect</span>
				<code className="min-w-0 truncate text-[11px] text-text-tertiary" title={command}>
					{command}
				</code>
			</div>
			<Button
				variant="ghost"
				size="sm"
				icon={copied ? <Check size={13} className="text-status-green" /> : <Copy size={13} />}
				onClick={() => void handleCopy()}
				aria-label={copied ? "Amp open command copied" : "Copy Amp open command"}
				title={command}
				className="shrink-0"
			>
				{copied ? "Copied" : "Copy command"}
			</Button>
		</div>
	);
}
