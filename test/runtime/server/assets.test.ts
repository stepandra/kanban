import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readAsset } from "../../../src/server/assets";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true })));
});

describe("readAsset", () => {
	it("serves WebAssembly with its streaming compilation MIME type", async () => {
		const directory = await mkdtemp(join(tmpdir(), "kanban-assets-"));
		temporaryDirectories.push(directory);
		await writeFile(join(directory, "renderer.wasm"), new Uint8Array([0, 97, 115, 109]));

		const asset = await readAsset(directory, "/renderer.wasm");

		expect(asset.contentType).toBe("application/wasm");
		expect(asset.content).toEqual(Buffer.from([0, 97, 115, 109]));
	});
});
