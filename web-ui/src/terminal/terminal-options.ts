import { defaultTheme, type OpenOptions } from "rioterm";

import type { ThemeTerminalColors } from "@/hooks/use-theme";

interface CreateKanbanTerminalOptionsInput {
	cursorColor: string;
	terminalBackgroundColor: string;
	themeColors: ThemeTerminalColors;
}

const TERMINAL_FONT_FAMILY =
	"'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, 'Courier New', monospace";

export function createKanbanTerminalOptions({
	cursorColor,
	terminalBackgroundColor,
	themeColors,
}: CreateKanbanTerminalOptionsInput): OpenOptions {
	// Light themes intentionally render the terminal against a dark palette and
	// invert the canvas in CSS. CSS custom properties are not valid Canvas2D
	// fillStyle values, so use the matching concrete terminal color for them.
	const background = terminalBackgroundColor.trim().startsWith("var(")
		? themeColors.surfacePrimary
		: terminalBackgroundColor;

	return {
		convertEol: false,
		cursorStyle: "block",
		detectUrls: true,
		fontFamily: TERMINAL_FONT_FAMILY,
		fontSize: 13,
		lineHeight: 1,
		scrollback: 10_000,
		theme: {
			...defaultTheme,
			background,
			cursor: cursorColor,
			foreground: themeColors.textPrimary,
			selectionBackground: themeColors.selectionBackground,
			selectionForeground: themeColors.selectionForeground,
		},
	};
}
