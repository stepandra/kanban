import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8")) as { version: string };

export default defineConfig({
	plugins: [tailwindcss(), react()],
	// RioTerm's wasm-bindgen glue resolves the binary relative to import.meta.url;
	// Vite dependency prebundling would move the glue without the sibling wasm.
	optimizeDeps: {
		exclude: ["rioterm"],
	},
	envPrefix: ["VITE_", "POSTHOG_"],
	define: {
		__APP_VERSION__: JSON.stringify(rootPkg.version),
	},
	build: {
		sourcemap: true,
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
			"@runtime-contract": resolve(__dirname, "../src/core/api-contract.ts"),
			"@runtime-agent-catalog": resolve(__dirname, "../src/core/agent-catalog.ts"),
			"@runtime-tool-call-display": resolve(__dirname, "../src/core/tool-call-display.ts"),
			"@runtime-shortcuts": resolve(__dirname, "../src/config/shortcut-utils.ts"),
			"@runtime-task-id": resolve(__dirname, "../src/core/task-id.ts"),
			"@runtime-task-title": resolve(__dirname, "../src/core/task-title.ts"),
			"@runtime-task-worktree-path": resolve(__dirname, "../src/workspace/task-worktree-path.ts"),
			"@runtime-task-state": resolve(__dirname, "../src/core/task-board-mutations.ts"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.KANBAN_WEB_UI_PORT || "4173"),
		strictPort: true,
		proxy: {
			"/api": {
				target: `http://127.0.0.1:${process.env.KANBAN_RUNTIME_PORT || "3484"}`,
				changeOrigin: true,
				ws: true,
			},
		},
	},
});
