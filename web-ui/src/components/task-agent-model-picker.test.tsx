import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskAgentModelPicker, useTaskAgentModelPicker } from "@/components/task-agent-model-picker";
import type { RuntimeAgentId } from "@/runtime/types";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => {
		root.unmount();
	});
	container.remove();
});

function HookProbe({ defaultAgentId }: { defaultAgentId: RuntimeAgentId | null }) {
	const { agentOptions } = useTaskAgentModelPicker({ defaultAgentId });
	return (
		<ul>
			{agentOptions.map((option) => (
				<li key={option.value} data-value={option.value}>
					{option.label}
				</li>
			))}
		</ul>
	);
}

describe("useTaskAgentModelPicker", () => {
	it("labels the first option with the default agent and omits it from the explicit list", () => {
		act(() => {
			root.render(<HookProbe defaultAgentId="claude" />);
		});

		const items = Array.from(container.querySelectorAll("li"));
		expect(items[0]?.textContent).toBe("Claude Code");
		expect(items.some((item) => item.dataset.value === "claude")).toBe(false);
	});

	it("falls back to a generic default label without a default agent", () => {
		act(() => {
			root.render(<HookProbe defaultAgentId={null} />);
		});

		const items = Array.from(container.querySelectorAll("li"));
		expect(items[0]?.textContent).toBe("Default");
	});
});

describe("TaskAgentModelPicker", () => {
	it("renders the agent options and reports selection changes", () => {
		const onAgentIdChange = vi.fn();
		act(() => {
			root.render(
				<TaskAgentModelPicker
					agentId={undefined}
					onAgentIdChange={onAgentIdChange}
					agentOptions={[
						{ value: "", label: "Claude Code" },
						{ value: "codex", label: "OpenAI Codex" },
					]}
				/>,
			);
		});

		const toggle = container.querySelector("button");
		expect(toggle?.textContent).toContain("Override Agent Settings");
		act(() => {
			toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const select = container.querySelector("select");
		expect(select).not.toBeNull();
		if (!select) {
			return;
		}
		expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["Claude Code", "OpenAI Codex"]);

		act(() => {
			select.value = "codex";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onAgentIdChange).toHaveBeenCalledWith("codex");
	});
});
