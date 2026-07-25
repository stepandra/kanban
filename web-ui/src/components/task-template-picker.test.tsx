import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskTemplatePicker } from "@/components/task-template-picker";
import type { RuntimeTaskTemplate } from "@/runtime/types";

const SAMPLE_TEMPLATES: RuntimeTaskTemplate[] = [
	{ id: "tpl-1", name: "Bug fix", prompt: "Fix the bug" },
	{ id: "tpl-2", name: "Docs", prompt: "Write docs", baseRef: "main", autoReviewEnabled: true, autoReviewMode: "pr" },
];

function findButtonByText(root: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.trim().includes(text)) ??
		null) as HTMLButtonElement | null;
}

function findButtonByAriaLabel(root: ParentNode, ariaLabel: string): HTMLButtonElement | null {
	return root.querySelector<HTMLButtonElement>(`button[aria-label='${ariaLabel}']`);
}

function click(element: Element): void {
	element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("TaskTemplatePicker", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	const renderPicker = async (props: {
		templates?: RuntimeTaskTemplate[];
		isSaving?: boolean;
		canSaveCurrent?: boolean;
		onApply?: (template: RuntimeTaskTemplate) => void;
		onSaveCurrent?: (name: string) => void;
		onDelete?: (templateId: string) => void;
	}): Promise<void> => {
		await act(async () => {
			root.render(
				<TaskTemplatePicker
					templates={props.templates ?? []}
					isSaving={props.isSaving ?? false}
					canSaveCurrent={props.canSaveCurrent ?? true}
					onApply={props.onApply ?? (() => {})}
					onSaveCurrent={props.onSaveCurrent ?? (() => {})}
					onDelete={props.onDelete ?? (() => {})}
				/>,
			);
		});
	};

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("disables template application when there are no templates", async () => {
		await renderPicker({ templates: [] });

		const trigger = findButtonByText(container, "No templates");
		expect(trigger).not.toBeNull();
		expect(trigger?.disabled).toBe(true);
	});

	it("disables saving when the current prompt is empty", async () => {
		await renderPicker({ templates: SAMPLE_TEMPLATES, canSaveCurrent: false });

		const saveButton = findButtonByText(container, "Save as template");
		expect(saveButton).not.toBeNull();
		expect(saveButton?.disabled).toBe(true);
	});

	it("saves the current prompt under a typed name", async () => {
		const onSaveCurrent = vi.fn();
		await renderPicker({ templates: [], canSaveCurrent: true, onSaveCurrent });

		const saveButton = findButtonByText(container, "Save as template");
		expect(saveButton).not.toBeNull();
		act(() => {
			click(saveButton as HTMLButtonElement);
		});

		const input = container.querySelector<HTMLInputElement>("#task-template-name");
		expect(input).not.toBeNull();
		act(() => {
			if (input) {
				const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
				valueSetter?.call(input, "Bug fix");
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});

		const form = container.querySelector("form");
		expect(form).not.toBeNull();
		act(() => {
			form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});

		expect(onSaveCurrent).toHaveBeenCalledWith("Bug fix");
		expect(container.querySelector("#task-template-name")).toBeNull();
	});

	it("cancels naming without saving", async () => {
		const onSaveCurrent = vi.fn();
		await renderPicker({ templates: [], canSaveCurrent: true, onSaveCurrent });

		act(() => {
			click(findButtonByText(container, "Save as template") as HTMLButtonElement);
		});
		act(() => {
			click(findButtonByAriaLabel(container, "Cancel saving template") as HTMLButtonElement);
		});

		expect(onSaveCurrent).not.toHaveBeenCalled();
		expect(container.querySelector("#task-template-name")).toBeNull();
	});

	it("applies and deletes templates from the dropdown", async () => {
		const onApply = vi.fn();
		const onDelete = vi.fn();
		await renderPicker({ templates: SAMPLE_TEMPLATES, onApply, onDelete });

		const trigger = findButtonByText(container, "Apply template");
		expect(trigger).not.toBeNull();
		act(() => {
			trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
		});

		const applyItem = Array.from(document.body.querySelectorAll("[role='menuitem']")).find((item) =>
			item.textContent?.includes("Docs"),
		);
		expect(applyItem).toBeDefined();
		act(() => {
			if (applyItem) {
				click(applyItem);
			}
		});
		expect(onApply).toHaveBeenCalledWith(SAMPLE_TEMPLATES[1]);

		act(() => {
			trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
		});
		const deleteButton = document.body.querySelector<HTMLButtonElement>(
			"button[aria-label='Delete template Bug fix']",
		);
		expect(deleteButton).not.toBeNull();
		act(() => {
			if (deleteButton) {
				click(deleteButton);
			}
		});
		expect(onDelete).toHaveBeenCalledWith("tpl-1");
	});
});
