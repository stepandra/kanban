import { useHotkeys } from "react-hotkeys-hook";

import type { CardSelection } from "@/types";
import { isTypingTarget } from "@/utils/keyboard-target";

function isEventInsideDialog(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("[role='dialog']") !== null;
}

interface UseAppHotkeysInput {
	selectedCard: CardSelection | null;
	isDetailTerminalOpen: boolean;
	isHomeTerminalOpen: boolean;
	isHomeGitHistoryOpen: boolean;
	canUseCreateTaskShortcut: boolean;
	handleToggleDetailTerminal: () => void;
	handleToggleHomeTerminal: () => void;
	handleToggleExpandDetailTerminal: () => void;
	handleToggleExpandHomeTerminal: () => void;
	handleOpenCreateTask: () => void;
	handleOpenSettings: () => void;
	handleToggleGitHistory: () => void;
	handleCloseGitHistory: () => void;
	handleBackToBoard: () => void;
	onStartAllTasks: () => void;
}

export function useAppHotkeys({
	selectedCard,
	isDetailTerminalOpen,
	isHomeTerminalOpen,
	isHomeGitHistoryOpen,
	canUseCreateTaskShortcut,
	handleToggleDetailTerminal,
	handleToggleHomeTerminal,
	handleToggleExpandDetailTerminal,
	handleToggleExpandHomeTerminal,
	handleOpenCreateTask,
	handleOpenSettings,
	handleToggleGitHistory,
	handleCloseGitHistory,
	handleBackToBoard,
	onStartAllTasks,
}: UseAppHotkeysInput): void {
	useHotkeys(
		"mod+j",
		() => {
			if (selectedCard) {
				handleToggleDetailTerminal();
				return;
			}
			handleToggleHomeTerminal();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleToggleDetailTerminal, handleToggleHomeTerminal, selectedCard],
	);

	useHotkeys(
		"mod+b",
		onStartAllTasks,
		{
			enableOnContentEditable: false,
			enableOnFormTags: false,
			preventDefault: true,
		},
		[onStartAllTasks],
	);

	useHotkeys(
		"mod+m",
		() => {
			if (selectedCard) {
				if (isDetailTerminalOpen) {
					handleToggleExpandDetailTerminal();
				}
				return;
			}
			if (isHomeTerminalOpen) {
				handleToggleExpandHomeTerminal();
			}
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[
			handleToggleExpandDetailTerminal,
			handleToggleExpandHomeTerminal,
			isDetailTerminalOpen,
			isHomeTerminalOpen,
			selectedCard,
		],
	);

	useHotkeys(
		"c",
		() => {
			if (!canUseCreateTaskShortcut) {
				return;
			}
			handleOpenCreateTask();
		},
		{ preventDefault: true },
		[canUseCreateTaskShortcut, handleOpenCreateTask],
	);

	useHotkeys(
		"mod+g",
		() => {
			handleToggleGitHistory();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleToggleGitHistory],
	);

	useHotkeys(
		"mod+shift+s",
		() => {
			handleOpenSettings();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleOpenSettings],
	);

	useHotkeys(
		"escape",
		(event) => {
			if (isEventInsideDialog(event.target) || event.defaultPrevented) {
				return;
			}
			if (selectedCard) {
				// Esc returns from the detail view to the board; leave Esc alone while
				// typing (terminal, inputs) so it can reach the focused control.
				if (isTypingTarget(event.target)) {
					return;
				}
				event.preventDefault();
				handleBackToBoard();
				return;
			}
			if (!isHomeGitHistoryOpen) {
				return;
			}
			event.preventDefault();
			handleCloseGitHistory();
		},
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[handleBackToBoard, handleCloseGitHistory, isHomeGitHistoryOpen, selectedCard],
	);
}
