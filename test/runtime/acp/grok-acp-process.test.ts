import { describe, expect, it } from "vitest";

import { buildGrokServeArgs } from "../../../src/acp/grok-acp-process";

describe("Grok ACP process launch", () => {
	it("keeps Grok model and subagent routing in config by omitting every model flag", () => {
		const args = buildGrokServeArgs(2419);

		expect(args).toEqual(["agent", "--always-approve", "serve", "--bind", "127.0.0.1:2419"]);
		expect(args).not.toContain("--model");
		expect(args).not.toContain("-m");
	});
});
