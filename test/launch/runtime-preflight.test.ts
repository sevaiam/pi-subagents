import { chmodSync, readdirSync, symlinkSync } from "node:fs";
import { resolveRuntimeExecutable, getPiInvocation } from "../../src/launch/child-command.ts";
import { buildInteractiveShellCommand } from "../../src/launch/shell-command.ts";
import { assert, createTestDir, describe, it, join, readFileSync, writeExecutable, writeFileSync } from "../support/index.ts";

describe("child runtime preflight", () => {
	it("keeps an installed runtime and resolves only the missing runtime's own family", () => {
		const dir = createTestDir();
		const node = writeExecutable(dir, "node", "#!/bin/sh\nexit 0\n");
		const bun = writeExecutable(dir, "bun", "#!/bin/sh\nexit 0\n");
		assert.equal(resolveRuntimeExecutable(process.execPath, { PATH: "" }), process.execPath);
		assert.equal(resolveRuntimeExecutable("/removed/Cellar/node/bin/node", { PATH: dir }), node);
		assert.equal(resolveRuntimeExecutable("/removed/bun", { PATH: dir }), bun);
		assert.throws(() => resolveRuntimeExecutable("/removed/pi", { PATH: dir }), /Restart Pi/);
		assert.throws(() => resolveRuntimeExecutable("/removed/node", { PATH: "" }), /put node on PATH/);
	});

	it("skips broken links and non-executable files without evaluating PATH", () => {
		const bad = createTestDir();const good = createTestDir();
		writeFileSync(join(bad, "node"), "not executable");chmodSync(join(bad, "node"), 0o600);
		const node = writeExecutable(good, "node", "#!/bin/sh\nexit 0\n");
		assert.equal(resolveRuntimeExecutable("/removed/node", { PATH: `${bad}:${good}` }), node);
		symlinkSync("/missing/bun", join(bad, "bun"));
		assert.throws(() => resolveRuntimeExecutable("/removed/bun", { PATH: `${bad}:${good}` }), /unavailable/);
	});

	it("honors Windows executable naming and PATHEXT without selecting shell wrappers", () => {
		const dir = createTestDir();
		const exe = writeExecutable(dir, "node.EXE", "unused");
		assert.equal(resolveRuntimeExecutable("C:\\removed\\node.exe", { PATH: dir, PATHEXT: ".CMD;.EXE" }, "win32"), exe);
		assert.throws(() => resolveRuntimeExecutable("C:\\removed\\bun.exe", { PATH: dir, PATHEXT: ".EXE" }, "win32"), /unavailable/);
	});

	it("preflights before capsule write and uses recovered runtime for runner and Pi argv", () => {
		const old = process.execPath;const dir = createTestDir();
		const runtime = writeExecutable(dir, "node", "#!/bin/sh\nexit 0\n");
		const root = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR!;
		const before = readdirSync(root);
		delete process.env.PI_SUBAGENT_PI_COMMAND;
		try {
			process.execPath = "/removed/pi";
			assert.throws(() => buildInteractiveShellCommand({ piArgs: [], envOverrides: {}, doneSentinelFile: "/tmp/unused" }), /runtime is unavailable/);
			assert.deepEqual(readdirSync(root), before);
			process.execPath = "/removed/node";process.env.PATH = dir;
			const args = ["--model", "provider/model", "quoted ' argument"];
			const expected = getPiInvocation(args);
			const built = buildInteractiveShellCommand({ piArgs: args, envOverrides: {}, doneSentinelFile: "/tmp/unused" });
			try {
				assert.equal(built.argv[0], runtime);
				const capsule = JSON.parse(readFileSync(built.capsulePath, "utf8"));
				assert.equal(capsule.command, runtime);
				assert.deepEqual(capsule.args, expected.args);
				assert.deepEqual(capsule.args.slice(-args.length), args);
			} finally { built.dispose(); }
		} finally { process.execPath = old; }
	});

	it("does not guess another Pi binary when the generic runtime's entrypoint disappeared", () => {
		const script = process.argv[1];
		delete process.env.PI_SUBAGENT_PI_COMMAND;
		try {
			process.argv[1] = "/removed/pi/cli.js";
			assert.throws(() => getPiInvocation([]), /refusing to guess/);
		} finally { process.argv[1] = script; }
	});

	it("preserves explicit wrapper invocation while independently preflighting its capsule runner", () => {
		const old = process.execPath;process.env.PI_SUBAGENT_PI_COMMAND = "'wrapper path' pi";
		try {
			process.execPath = "/removed/pi";
			assert.deepEqual(getPiInvocation(["task"]), { command: "wrapper path", args: ["pi", "task"] });
			assert.throws(() => buildInteractiveShellCommand({ piArgs: [], envOverrides: {}, doneSentinelFile: "/tmp/unused" }), /Restart Pi/);
		} finally { process.execPath = old; }
	});
});
