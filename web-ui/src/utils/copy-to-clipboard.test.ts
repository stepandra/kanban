import { afterEach, describe, expect, it, vi } from "vitest";

import { copyTextToClipboard } from "@/utils/copy-to-clipboard";

const originalExecCommand = document.execCommand;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Object.defineProperty(document, "execCommand", {
		configurable: true,
		value: originalExecCommand,
	});
});

describe("copyTextToClipboard", () => {
	it("uses the Clipboard API when available", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });

		await copyTextToClipboard("amp threads continue T-123");

		expect(writeText).toHaveBeenCalledWith("amp threads continue T-123");
	});

	it("falls back to selection-based copying when Clipboard permission is denied", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("denied"));
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const execCommand = vi.fn().mockReturnValue(true);
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: execCommand,
		});

		await copyTextToClipboard("amp threads continue T-456");

		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(document.querySelector("textarea")).toBeNull();
	});
});
