import { open, type RioTermHandle, type Terminal as RioTerminal } from "rioterm";
import { getTerminalThemeColors, type ThemeTerminalColors } from "@/hooks/use-theme";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskSessionSummary,
	RuntimeTerminalWsClientMessage,
	RuntimeTerminalWsServerMessage,
} from "@/runtime/types";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { createKanbanTerminalOptions } from "@/terminal/terminal-options";
import {
	appendTerminalHeuristicText,
	hasInterruptAcknowledgement,
	hasLikelyShellPrompt,
} from "@/terminal/terminal-prompt-heuristics";
import { isMacPlatform } from "@/utils/platform";

const SHIFT_ENTER_SEQUENCE = "\n";
const RESIZE_DEBOUNCE_MS = 50;
const INTERRUPT_IDLE_SETTLE_MS = 250;
const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";

interface PersistentTerminalAppearance {
	cursorColor: string;
	terminalBackgroundColor: string;
	themeColors?: ThemeTerminalColors;
}

interface PersistentTerminalSubscriber {
	onConnectionReady?: (taskId: string) => void;
	onLastError?: (message: string | null) => void;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onOutputText?: (text: string) => void;
}

interface MountPersistentTerminalOptions {
	autoFocus?: boolean;
	isVisible?: boolean;
}

interface EnsurePersistentTerminalInput extends PersistentTerminalAppearance {
	taskId: string;
	workspaceId: string;
}

function generateTerminalClientId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `terminal-${Math.random().toString(36).slice(2, 10)}`;
}

function getTerminalIoWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/io`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

function getTerminalControlWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/control`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

function decodeTerminalSocketChunk(decoder: TextDecoder, data: string | ArrayBuffer | Blob): string {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return decoder.decode(new Uint8Array(data), { stream: true });
	}
	return "";
}

function getTerminalSocketWriteData(data: string | ArrayBuffer | Blob): string | Uint8Array | null {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	return null;
}

function getTerminalSocketChunkByteLength(data: string | ArrayBuffer | Blob): number {
	if (typeof data === "string") {
		return new TextEncoder().encode(data).byteLength;
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength;
	}
	return 0;
}

function appearancesMatch(left: PersistentTerminalAppearance, right: PersistentTerminalAppearance): boolean {
	return (
		left.cursorColor === right.cursorColor &&
		left.terminalBackgroundColor === right.terminalBackgroundColor &&
		left.themeColors?.textPrimary === right.themeColors?.textPrimary &&
		left.themeColors?.surfacePrimary === right.themeColors?.surfacePrimary &&
		left.themeColors?.selectionBackground === right.themeColors?.selectionBackground &&
		left.themeColors?.selectionForeground === right.themeColors?.selectionForeground
	);
}

function openTerminalLink(uri: string): void {
	try {
		const url = new URL(uri);
		if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
			return;
		}
		window.open(url.href, "_blank", "noopener,noreferrer");
	} catch {
		// Ignore malformed terminal links.
	}
}

function getParkingRoot(): HTMLDivElement {
	const existingRoot = document.getElementById(PARKING_ROOT_ID);
	if (existingRoot instanceof HTMLDivElement) {
		return existingRoot;
	}
	const root = document.createElement("div");
	root.id = PARKING_ROOT_ID;
	root.setAttribute("aria-hidden", "true");
	Object.assign(root.style, {
		position: "fixed",
		left: "-10000px",
		top: "-10000px",
		width: "1px",
		height: "1px",
		overflow: "hidden",
		opacity: "0",
		pointerEvents: "none",
	});
	document.body.appendChild(root);
	return root;
}

function buildKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

class PersistentTerminal {
	private terminal: RioTerminal | null = null;
	private terminalHandle: RioTermHandle | null = null;
	private readonly terminalReady: Promise<void>;
	private readonly hostElement: HTMLDivElement;
	private readonly scrollbackControl: HTMLInputElement;
	private readonly subscribers = new Set<PersistentTerminalSubscriber>();
	private readonly parkingRoot: HTMLDivElement;
	// This identifies one browser viewer, not the PTY session itself.
	// The server uses it to keep per-tab restore and socket state while all tabs
	// still share the same taskId backed PTY.
	private readonly clientId = generateTerminalClientId();
	private appearance: PersistentTerminalAppearance;
	private latestSummary: RuntimeTaskSessionSummary | null = null;
	private lastError: string | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private scrollbackFrame: number | null = null;
	private visibleContainer: HTMLDivElement | null = null;
	private ioSocket: WebSocket | null = null;
	private controlSocket: WebSocket | null = null;
	private connectionReady = false;
	private restoreCompleted = false;
	private outputTextDecoder = new TextDecoder();
	private terminalWriteQueue: Promise<void> = Promise.resolve();
	private disposed = false;
	private readonly handleHostKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Enter" || !event.shiftKey || !this.terminal) {
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
		this.terminal.input(SHIFT_ENTER_SEQUENCE);
	};
	private readonly handleScrollbackInput = (): void => {
		if (!this.terminal) {
			return;
		}
		const desiredOffset = Number(this.scrollbackControl.value);
		this.terminal.scrollLines(desiredOffset - this.terminal.displayOffset());
	};

	constructor(
		private readonly taskId: string,
		private readonly workspaceId: string,
		appearance: PersistentTerminalAppearance,
	) {
		this.appearance = appearance;
		this.parkingRoot = getParkingRoot();
		this.hostElement = document.createElement("div");
		Object.assign(this.hostElement.style, {
			width: "100%",
			height: "100%",
			position: "relative",
		});
		this.parkingRoot.appendChild(this.hostElement);
		this.hostElement.addEventListener("keydown", this.handleHostKeyDown, true);
		this.scrollbackControl = document.createElement("input");
		this.scrollbackControl.type = "range";
		this.scrollbackControl.min = "0";
		this.scrollbackControl.max = "1";
		this.scrollbackControl.value = "1";
		this.scrollbackControl.hidden = true;
		this.scrollbackControl.className = "kb-terminal-scrollback";
		this.scrollbackControl.setAttribute("aria-label", "Terminal scrollback");
		this.scrollbackControl.addEventListener("input", this.handleScrollbackInput);
		this.hostElement.appendChild(this.scrollbackControl);
		const initialGeometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);
		this.terminalReady = this.openTerminal(initialGeometry.cols, initialGeometry.rows)
			.then(() => {
				this.ensureConnected();
			})
			.catch((error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				this.lastError = `Terminal renderer failed to start: ${detail}`;
				this.notifyLastError();
			});
	}

	private async openTerminal(cols: number, rows: number, snapshot = ""): Promise<void> {
		const handle = await open(this.hostElement, {
			...createKanbanTerminalOptions({
				cursorColor: this.appearance.cursorColor,
				terminalBackgroundColor: this.appearance.terminalBackgroundColor,
				themeColors: this.appearance.themeColors ?? getTerminalThemeColors(),
			}),
			autoFocus: false,
			cols,
			fit: false,
			linkHandler: {
				activate: openTerminalLink,
			},
			renderer: "canvas",
			rows,
		});
		if (this.disposed) {
			handle.dispose();
			return;
		}
		handle.terminal.setAltIsMeta(isMacPlatform);
		if (snapshot) {
			handle.terminal.write(snapshot);
		}
		this.hostElement.querySelector("textarea")?.setAttribute("aria-label", "Terminal input");
		handle.terminal.onData((data) => {
			this.sendIoData(data);
		});
		this.terminal = handle.terminal;
		this.terminalHandle = handle;
		handle.terminal.onUpdate(() => {
			this.scheduleScrollbackControlSync();
		});
		this.syncScrollbackControl();
	}

	private scheduleScrollbackControlSync(): void {
		if (this.scrollbackFrame !== null) {
			return;
		}
		this.scrollbackFrame = window.requestAnimationFrame(() => {
			this.scrollbackFrame = null;
			this.syncScrollbackControl();
		});
	}

	private syncScrollbackControl(): void {
		if (!this.terminal) {
			this.scrollbackControl.hidden = true;
			return;
		}
		const historySize = this.terminal.historySize();
		this.scrollbackControl.hidden = historySize === 0;
		this.scrollbackControl.max = String(Math.max(1, historySize));
		this.scrollbackControl.value = String(this.terminal.displayOffset());
	}

	private notifyLastError(): void {
		for (const subscriber of this.subscribers) {
			subscriber.onLastError?.(this.lastError);
		}
	}

	private notifySummary(summary: RuntimeTaskSessionSummary): void {
		this.latestSummary = summary;
		for (const subscriber of this.subscribers) {
			subscriber.onSummary?.(summary);
		}
	}

	private notifyOutputText(text: string): void {
		for (const subscriber of this.subscribers) {
			subscriber.onOutputText?.(text);
		}
	}

	private notifyConnectionReady(): void {
		this.connectionReady = true;
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionReady?.(this.taskId);
		}
	}

	private sendControlMessage(message: RuntimeTerminalWsClientMessage): void {
		if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
			return;
		}
		this.controlSocket.send(JSON.stringify(message));
	}

	private sendIoData(data: string | Uint8Array): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.ioSocket.send(data);
		return true;
	}

	private enqueueTerminalWrite(
		data: string | Uint8Array,
		options: {
			ackBytes?: number;
			notifyText?: string | null;
		} = {},
	): Promise<void> {
		const ackBytes = options.ackBytes ?? 0;
		const notifyText = options.notifyText ?? null;
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(async () => {
				await this.terminalReady;
				if (this.disposed || !this.terminal) {
					return;
				}
				// RioTerm parses synchronously. Returning from write() is the same
				// commit boundary that xterm's write callback represented here.
				this.terminal.write(data);
				if (notifyText) {
					this.notifyOutputText(notifyText);
				}
				if (ackBytes > 0) {
					this.sendControlMessage({
						type: "output_ack",
						bytes: ackBytes,
					});
				}
			});
		return this.terminalWriteQueue;
	}

	private async applyRestore(
		snapshot: string,
		cols: number | null | undefined,
		rows: number | null | undefined,
	): Promise<void> {
		await this.terminalWriteQueue.catch(() => undefined);
		await this.terminalReady;
		if (!this.terminal) {
			throw new Error("Terminal renderer is unavailable");
		}
		this.terminal.write("\u001bc");
		if (cols && rows && (this.terminal.options.cols !== cols || this.terminal.options.rows !== rows)) {
			this.terminal.resize(cols, rows);
		}
		if (!snapshot) {
			return;
		}
		await this.enqueueTerminalWrite(snapshot);
	}

	private requestResize(): void {
		if (!this.visibleContainer || !this.terminal || !this.terminalHandle) {
			return;
		}
		const bounds = this.visibleContainer.getBoundingClientRect();
		const pixelWidth = Math.round(bounds.width);
		const pixelHeight = Math.round(bounds.height);
		if (pixelWidth <= 0 || pixelHeight <= 0) {
			return;
		}
		this.terminalHandle.renderer.fit(pixelWidth, pixelHeight);
		reportTerminalGeometry(this.taskId, {
			cols: this.terminal.options.cols,
			rows: this.terminal.options.rows,
		});
		this.sendControlMessage({
			type: "resize",
			cols: this.terminal.options.cols,
			rows: this.terminal.options.rows,
			pixelWidth: pixelWidth > 0 ? pixelWidth : undefined,
			pixelHeight: pixelHeight > 0 ? pixelHeight : undefined,
		});
	}

	private connectIo(): void {
		if (this.ioSocket) {
			return;
		}
		const ioSocket = new WebSocket(getTerminalIoWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		ioSocket.binaryType = "arraybuffer";
		ioSocket.addEventListener("message", (event) => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			const writeData = getTerminalSocketWriteData(event.data);
			if (!writeData) {
				return;
			}
			const decoded = decodeTerminalSocketChunk(this.outputTextDecoder, event.data);
			void this.enqueueTerminalWrite(writeData, {
				ackBytes: getTerminalSocketChunkByteLength(event.data),
				notifyText: decoded || null,
			});
		});
		this.ioSocket = ioSocket;
		ioSocket.onopen = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.lastError = null;
			this.notifyLastError();
			if (this.restoreCompleted && this.visibleContainer) {
				this.requestResize();
			}
			if (this.restoreCompleted) {
				this.notifyConnectionReady();
			}
		};
		ioSocket.onerror = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.lastError = "Terminal stream failed.";
			this.notifyLastError();
		};
		ioSocket.onclose = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.ioSocket = null;
			this.outputTextDecoder = new TextDecoder();
			this.connectionReady = false;
			this.restoreCompleted = false;
			this.lastError = "Terminal stream closed. Close and reopen to reconnect.";
			this.notifyLastError();
		};
	}

	private connectControl(): void {
		const controlSocket = new WebSocket(getTerminalControlWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		this.controlSocket = controlSocket;
		controlSocket.onopen = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.lastError = null;
			this.notifyLastError();
		};
		controlSocket.onmessage = (event) => {
			let payload: RuntimeTerminalWsServerMessage;
			try {
				payload = JSON.parse(String(event.data)) as RuntimeTerminalWsServerMessage;
			} catch {
				// Ignore malformed control frames.
				return;
			}

			if (payload.type === "restore") {
				this.restoreCompleted = false;
				void this.applyRestore(payload.snapshot, payload.cols, payload.rows)
					.then(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.restoreCompleted = true;
						this.sendControlMessage({ type: "restore_complete" });
						if (this.ioSocket && this.visibleContainer) {
							this.requestResize();
						}
						if (this.ioSocket) {
							this.notifyConnectionReady();
						}
					})
					.catch(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.lastError = "Terminal restore failed.";
						this.notifyLastError();
					});
				return;
			}
			if (payload.type === "state") {
				this.notifySummary(payload.summary);
				return;
			}
			if (payload.type === "exit") {
				const label = payload.code == null ? "session exited" : `session exited with code ${payload.code}`;
				void this.enqueueTerminalWrite(`\r\n[kanban] ${label}\r\n`);
				return;
			}
			if (payload.type === "error") {
				this.lastError = payload.message;
				this.notifyLastError();
				void this.enqueueTerminalWrite(`\r\n[kanban] ${payload.message}\r\n`);
			}
		};
		controlSocket.onerror = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.lastError = "Terminal control connection failed.";
			this.notifyLastError();
		};
		controlSocket.onclose = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.controlSocket = null;
			this.lastError = "Terminal control connection closed. Close and reopen to reconnect.";
			this.notifyLastError();
		};
	}

	private ensureConnected(): void {
		if (this.disposed) {
			return;
		}
		if (!this.ioSocket) {
			this.connectIo();
		}
		if (!this.controlSocket) {
			this.connectControl();
		}
	}

	private updateAppearance(appearance: PersistentTerminalAppearance): void {
		if (appearancesMatch(this.appearance, appearance)) {
			return;
		}
		this.appearance = appearance;
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(async () => {
				await this.terminalReady;
				if (this.disposed || !this.terminal || !this.terminalHandle) {
					return;
				}
				const snapshot = this.terminal.serialize();
				const { cols, rows } = this.terminal.options;
				const restoreFocus = this.hostElement.contains(document.activeElement);
				const previousHandle = this.terminalHandle;
				this.terminal = null;
				this.terminalHandle = null;
				previousHandle.dispose();
				await this.openTerminal(cols, rows, snapshot);
				if (this.visibleContainer) {
					this.requestResize();
				}
				if (restoreFocus) {
					(this.terminalHandle as RioTermHandle | null)?.focus();
				}
			});
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.updateAppearance(appearance);
	}

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber.onLastError?.(this.lastError);
		if (this.latestSummary) {
			subscriber.onSummary?.(this.latestSummary);
		}
		if (this.connectionReady) {
			subscriber.onConnectionReady?.(this.taskId);
		}
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	mount(
		container: HTMLDivElement,
		appearance: PersistentTerminalAppearance,
		options: MountPersistentTerminalOptions,
	): void {
		if (this.disposed) {
			return;
		}
		this.ensureConnected();
		this.updateAppearance(appearance);
		if (this.visibleContainer !== container) {
			this.visibleContainer = container;
			container.appendChild(this.hostElement);
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
		}
		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeTimer !== null) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.requestResize();
			}, RESIZE_DEBOUNCE_MS);
		});
		this.resizeObserver.observe(container);
		if (options.isVisible !== false) {
			window.requestAnimationFrame(() => {
				void this.terminalWriteQueue.then(async () => {
					await this.terminalReady;
					if (this.disposed || this.visibleContainer !== container) {
						return;
					}
					this.requestResize();
					if (options.autoFocus) {
						this.terminalHandle?.focus();
					}
				});
			});
		}
	}

	unmount(container: HTMLDivElement | null): void {
		if (this.disposed && this.visibleContainer === null) {
			return;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.resizeTimer !== null) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		if (this.scrollbackFrame !== null) {
			window.cancelAnimationFrame(this.scrollbackFrame);
			this.scrollbackFrame = null;
		}
		if (container && this.visibleContainer !== container) {
			return;
		}
		this.visibleContainer = null;
		clearTerminalGeometry(this.taskId);
		this.parkingRoot.appendChild(this.hostElement);
	}

	focus(): void {
		void this.terminalWriteQueue.then(() => {
			this.terminalHandle?.focus();
		});
	}

	input(text: string): boolean {
		if (!this.terminal || !this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.terminal.input(text);
		return true;
	}

	paste(text: string): boolean {
		if (!this.terminal || !this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.terminal.paste(text);
		return true;
	}

	clear(): void {
		void this.enqueueTerminalWrite("\u001b[2J\u001b[3J\u001b[H");
	}

	reset(): void {
		void this.enqueueTerminalWrite("\u001bc");
	}

	waitForLikelyPrompt(timeoutMs: number): Promise<boolean> {
		if (timeoutMs <= 0) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			let buffer = "";
			let sawInterruptAcknowledgement = false;
			let settled = false;
			let idleTimer: number | null = null;

			const cleanup = (result: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutId);
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				unsubscribe();
				resolve(result);
			};

			const scheduleIdleCompletion = () => {
				if (!sawInterruptAcknowledgement) {
					return;
				}
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				idleTimer = window.setTimeout(() => {
					cleanup(true);
				}, INTERRUPT_IDLE_SETTLE_MS);
			};

			const unsubscribe = this.subscribe({
				onOutputText: (text) => {
					buffer = appendTerminalHeuristicText(buffer, text);
					if (hasLikelyShellPrompt(buffer)) {
						cleanup(true);
						return;
					}
					if (hasInterruptAcknowledgement(buffer)) {
						sawInterruptAcknowledgement = true;
					}
					scheduleIdleCompletion();
				},
			});

			const timeoutId = window.setTimeout(() => {
				cleanup(false);
			}, timeoutMs);
		});
	}

	async stop(): Promise<void> {
		this.sendControlMessage({ type: "stop" });
		const trpcClient = getRuntimeTrpcClient(this.workspaceId);
		await trpcClient.runtime.stopTaskSession.mutate({ taskId: this.taskId });
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.unmount(this.visibleContainer);
		this.ioSocket?.close();
		this.controlSocket?.close();
		this.ioSocket = null;
		this.controlSocket = null;
		this.subscribers.clear();
		this.hostElement.removeEventListener("keydown", this.handleHostKeyDown, true);
		this.scrollbackControl.removeEventListener("input", this.handleScrollbackInput);
		this.terminalHandle?.dispose();
		this.terminal = null;
		this.terminalHandle = null;
		this.hostElement.remove();
	}
}

const terminals = new Map<string, PersistentTerminal>();

export function ensurePersistentTerminal(input: EnsurePersistentTerminalInput): PersistentTerminal {
	const key = buildKey(input.workspaceId, input.taskId);
	let terminal = terminals.get(key);
	if (!terminal) {
		terminal = new PersistentTerminal(input.taskId, input.workspaceId, {
			cursorColor: input.cursorColor,
			terminalBackgroundColor: input.terminalBackgroundColor,
			themeColors: input.themeColors,
		});
		terminals.set(key, terminal);
		return terminal;
	}
	terminal.setAppearance({
		cursorColor: input.cursorColor,
		terminalBackgroundColor: input.terminalBackgroundColor,
		themeColors: input.themeColors,
	});
	return terminal;
}

export function disposePersistentTerminal(workspaceId: string, taskId: string): void {
	const key = buildKey(workspaceId, taskId);
	const terminal = terminals.get(key);
	if (!terminal) {
		return;
	}
	terminal.dispose();
	terminals.delete(key);
}

export function disposeAllPersistentTerminalsForWorkspace(workspaceId: string): void {
	for (const [key, terminal] of terminals.entries()) {
		if (!key.startsWith(`${workspaceId}:`)) {
			continue;
		}
		terminal.dispose();
		terminals.delete(key);
	}
}
