import { describe, expect, it } from "vitest";

import { getTerminalThemeColors } from "@/hooks/use-theme";
import { createKanbanTerminalOptions } from "@/terminal/terminal-options";

describe("createKanbanTerminalOptions", () => {
	it("configures RioTerm for Kanban's PTY stream", () => {
		const options = createKanbanTerminalOptions({
			cursorColor: "#abcdef",
			terminalBackgroundColor: "#101112",
			themeColors: getTerminalThemeColors("default"),
		});

		expect(options.cursorStyle).toBe("block");
		expect(options.detectUrls).toBe(true);
		expect(options.scrollback).toBe(10_000);
		expect(options.theme?.background).toBe("#101112");
		expect(options.theme?.cursor).toBe("#abcdef");
		expect(options.theme?.foreground).toBe("#E6EDF3");
	});

	it("resolves CSS-variable backgrounds to the theme's concrete canvas color", () => {
		const options = createKanbanTerminalOptions({
			cursorColor: "#abcdef",
			terminalBackgroundColor: "var(--color-surface-1)",
			themeColors: getTerminalThemeColors("light"),
		});

		expect(options.theme?.background).toBe("#000000");
	});
});
