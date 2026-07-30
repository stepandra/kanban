export async function copyTextToClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		return;
	} catch {
		// Browser permission policies can disable the modern Clipboard API even
		// on localhost. Fall through to the synchronous selection-based path.
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.append(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	textarea.remove();
	if (!copied) {
		throw new Error("Clipboard copy was rejected.");
	}
}
