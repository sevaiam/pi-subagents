import { registerSetTabTitleTool } from "../../src/tools/set-tab-title.ts";
import { assert, describe, it } from "../support/index.ts";
import { useFakeRex, REX_CHILD } from "../support/rex.ts";

describe("Rex optional title result", () => {
	it("reports protected labels as unchanged and successful own-child renames as set", async () => {
		const f = useFakeRex();
		const previous = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
		let tool: { execute: (id: string, params: { title: string }) => Promise<any> } | undefined;
		try {
			registerSetTabTitleTool({ registerTool: (definition: typeof tool) => { tool = definition; } } as never);
			assert.ok(tool);
			let result = await tool.execute("test", { title: "New task" });
			assert.equal(result.details.changed, false);
			assert.match(result.content[0].text, /Title unchanged/);
			assert.ok(!f.calls().some((args) => args.includes("rename")));
			process.env.REX_BLOCK = REX_CHILD;
			process.env.PI_SUBAGENT_NAME = "title-child";
			process.env.PI_SUBAGENT_SURFACE = REX_CHILD;
			process.env.PI_SUBAGENT_INITIAL_TITLE = "[worker] Title launch";
			f.setState({ label: "[s] [worker] Title launch" });
			result = await tool.execute("test", { title: "First task" });
			assert.match(result.content[0].text, /Title set/);
			assert.equal(f.calls().filter((args) => args.includes("rename")).at(-1)?.at(-1), "[s] [worker] First task");
			f.setState({ label: "[s] User manual replacement" });
			result = await tool.execute("test", { title: "Second task" });
			assert.equal(result.details.changed, false);
			assert.doesNotMatch(result.content[0].text, /Title set/);
			assert.equal(f.calls().filter((args) => args.includes("rename")).length, 1);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = previous;
		}
	});
});
