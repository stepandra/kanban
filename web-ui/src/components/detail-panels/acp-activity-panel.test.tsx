import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AcpActivityPanel } from "@/components/detail-panels/acp-activity-panel";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

const sendInputMock = vi.hoisted(() => vi.fn());
const stopSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			sendTaskSessionInput: { mutate: sendInputMock },
			stopTaskSession: { mutate: stopSessionMock },
		},
	}),
}));

function createSummary(): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		mode: "act",
		agentId: "grok",
		workspacePath: "/tmp/task-1",
		pid: null,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		acpConnection: {
			transport: "websocket",
			endpoint: "ws://127.0.0.1:2419/ws",
			zmxSessionName: "kanban.ws.grok.task.digest",
			attemptId: "attempt-1",
			generation: 1,
			queuedAt: 1,
			sessionId: "session-1",
			secretRef: "kanban-secret-file:/tmp/secret",
		},
		acpActivity: [
			{ sequence: 1, timestamp: 1, kind: "message", text: "Working on the ACP handshake." },
			{
				sequence: 2,
				timestamp: 2,
				kind: "tool",
				text: "Run tests",
				toolStatus: "completed",
			},
		],
		acpNextSequence: 3,
	};
}

describe("AcpActivityPanel", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		sendInputMock.mockReset();
		stopSessionMock.mockReset();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("renders structured activity and sends follow-up prompts through the ACP API", async () => {
		const summary = createSummary();
		sendInputMock.mockResolvedValue({ ok: true, summary });
		await act(async () => {
			root.render(
				<AcpActivityPanel taskId="task-1" workspaceId="workspace-1" summary={summary} onSummary={() => {}} />,
			);
		});

		expect(container.textContent).toContain("Working on the ACP handshake.");
		expect(container.textContent).toContain("Run tests");
		const textarea = container.querySelector('textarea[aria-label="ACP prompt"]');
		if (!(textarea instanceof HTMLTextAreaElement)) {
			throw new Error("Expected ACP prompt textarea.");
		}
		await act(async () => {
			const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			valueSetter?.call(textarea, "Continue with the focused tests");
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const form = textarea.form;
		if (!form) {
			throw new Error("Expected ACP prompt form.");
		}
		await act(async () => {
			form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		});

		expect(sendInputMock).toHaveBeenCalledWith({
			taskId: "task-1",
			text: "Continue with the focused tests",
			appendNewline: true,
		});
	});
});
