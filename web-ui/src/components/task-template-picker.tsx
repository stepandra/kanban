import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bookmark, ChevronDown, Plus, X } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import type { RuntimeTaskTemplate } from "@/runtime/types";

export function TaskTemplatePicker({
	templates,
	isSaving,
	canSaveCurrent,
	onApply,
	onSaveCurrent,
	onDelete,
}: {
	templates: RuntimeTaskTemplate[];
	isSaving: boolean;
	/** False when the current prompt is empty and cannot be saved. */
	canSaveCurrent: boolean;
	onApply: (template: RuntimeTaskTemplate) => void;
	onSaveCurrent: (name: string) => void;
	onDelete: (templateId: string) => void;
}): ReactElement {
	const [isNaming, setIsNaming] = useState(false);
	const [name, setName] = useState("");
	const focusNameInput = useCallback((element: HTMLInputElement | null) => {
		element?.focus();
	}, []);

	const handleSubmitName = () => {
		const trimmed = name.trim();
		if (!trimmed) {
			return;
		}
		onSaveCurrent(trimmed);
		setName("");
		setIsNaming(false);
	};

	if (isNaming) {
		return (
			<form
				className="flex items-center gap-1.5"
				onSubmit={(event) => {
					event.preventDefault();
					handleSubmitName();
				}}
			>
				<label htmlFor="task-template-name" className="text-[11px] text-text-secondary shrink-0">
					Template name
				</label>
				<input
					id="task-template-name"
					type="text"
					value={name}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							setName("");
							setIsNaming(false);
						}
					}}
					placeholder="e.g. Bug fix"
					ref={focusNameInput}
					className="flex-1 min-w-0 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
				/>
				<Button size="sm" type="submit" disabled={!name.trim() || isSaving}>
					Save
				</Button>
				<Button
					variant="ghost"
					size="sm"
					icon={<X size={12} />}
					onClick={() => {
						setName("");
						setIsNaming(false);
					}}
					aria-label="Cancel saving template"
				/>
			</form>
		);
	}

	return (
		<div className="flex items-center gap-2">
			<span className="text-[11px] text-text-secondary shrink-0">Template</span>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<Button variant="default" size="sm" icon={<Bookmark size={12} />} disabled={templates.length === 0}>
						<span className="inline-flex items-center gap-1">
							{templates.length > 0 ? "Apply template" : "No templates"}
							<ChevronDown size={12} />
						</span>
					</Button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						side="bottom"
						align="start"
						sideOffset={4}
						className="z-50 min-w-[220px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
						onCloseAutoFocus={(event) => event.preventDefault()}
					>
						{templates.map((template) => (
							<div key={template.id} className="group flex items-center">
								<DropdownMenu.Item
									className="flex-1 min-w-0 truncate rounded-sm px-2 py-1 text-[12px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3"
									onSelect={() => onApply(template)}
								>
									{template.name}
								</DropdownMenu.Item>
								<button
									type="button"
									onClick={() => onDelete(template.id)}
									disabled={isSaving}
									aria-label={`Delete template ${template.name}`}
									className="mr-1 rounded-sm p-1 text-text-tertiary hover:text-status-red hover:bg-surface-3 cursor-pointer disabled:opacity-40"
								>
									<X size={12} />
								</button>
							</div>
						))}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			<button
				type="button"
				onClick={() => setIsNaming(true)}
				disabled={!canSaveCurrent || isSaving}
				className="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
			>
				<Plus size={12} />
				Save as template
			</button>
		</div>
	);
}
