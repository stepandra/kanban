import { Play, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import type { BoardColumnId } from "@/types";

export function BoardBulkActionBar({
	selectedCount,
	canStart,
	canMoveToReview,
	canMoveToTrash,
	onMoveToColumn,
	onClearSelection,
}: {
	selectedCount: number;
	canStart: boolean;
	canMoveToReview: boolean;
	canMoveToTrash: boolean;
	onMoveToColumn: (toColumnId: BoardColumnId) => void;
	onClearSelection: () => void;
}): React.ReactElement {
	const [isTrashConfirmOpen, setIsTrashConfirmOpen] = useState(false);
	const taskLabel = selectedCount === 1 ? "task" : "tasks";

	return (
		<div className="flex items-center gap-2">
			<span className="text-xs text-text-secondary">{selectedCount} selected</span>
			<Button
				size="sm"
				variant="default"
				icon={<Play size={14} />}
				disabled={!canStart}
				onClick={() => onMoveToColumn("in_progress")}
			>
				Start
			</Button>
			<NativeSelect
				size="sm"
				value=""
				aria-label="Move selected tasks to column"
				onChange={(event) => {
					const target = event.currentTarget.value;
					if (target === "trash") {
						setIsTrashConfirmOpen(true);
						return;
					}
					if (target === "in_progress" || target === "review") {
						onMoveToColumn(target);
					}
				}}
			>
				<option value="" disabled>
					Move to…
				</option>
				<option value="in_progress" disabled={!canStart}>
					In Progress
				</option>
				<option value="review" disabled={!canMoveToReview}>
					Review
				</option>
				<option value="trash" disabled={!canMoveToTrash}>
					Done
				</option>
			</NativeSelect>
			<Button
				size="sm"
				variant="ghost"
				icon={<X size={14} />}
				aria-label="Clear selection"
				onClick={onClearSelection}
			/>
			<AlertDialog open={isTrashConfirmOpen} onOpenChange={setIsTrashConfirmOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>
						Move {selectedCount} {taskLabel} to Done?
					</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						The selected task sessions will be stopped and their workspaces cleaned up.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default">Cancel</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button variant="danger" onClick={() => onMoveToColumn("trash")}>
							Move to Done
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
