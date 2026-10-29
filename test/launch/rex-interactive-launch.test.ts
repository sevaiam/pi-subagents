import { mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { launchInteractiveSubagent } from "../../src/launch/interactive.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { stopRunningSubagent } from "../../src/runtime/wiring.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import { disposeEnvCapsule } from "../../src/launch/env-capsule.ts";
import { buildInteractiveShellCommand } from "../../src/launch/shell-command.ts";
import { assert, describe, it, createTestDir, createSessionFile, SESSION_HEADER, MODEL_CHANGE, USER_MSG,
	ASSISTANT_MSG, join, readFileSync, writeFileSync, existsSync, readSubagentLaunchMetadataForTest } from "../support/index.ts";
import { REX_CHILD, REX_PARENT, REX_SESSION, useFakeRex } from "../support/rex.ts";
import "../support/ambient-spawn-grant.ts";

function launchFixture() {
	const fake = useFakeRex();
	const cwd = createTestDir();
	const childCwd = join(cwd, "child cwd");mkdirSync(childCwd);
	process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "rex-worker.md"), ["---", "name: rex-worker", "auto-exit: true",
		"cwd: child cwd", "env: PI_SUBAGENT_HERDR_PLACEMENT=right-stack", "trust-project: true", "---", "Run task."].join("\n"));
	const sessionFile = createSessionFile(cwd, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
	const ctx = { cwd, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent-session-id", getLeafId: () => "asst-001" } };
	return { ...fake, cwd, childCwd, ctx };
}

const runtime = { getContextWindow: () => 4096, getShellReadyDelayMs: () => { throw new Error("Rex must not stage into a shell"); } };
const params = { name: "rex-test-worker", title: "Rex backend launch test", agent: "rex-worker", task: "Test native launch." };
const quietResult = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
const resumeRuntime = () => ({ ...runtime, isMuxAvailable: () => true,
	watchSubagent: quietResult, watchBackgroundSubagent: quietResult,
	getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
	startWidgetRefresh: () => {}, runningSubagents: new Map() });

function capsuleFrom(calls: string[][]): { path: string; argv: string[] } {
	const split = calls.filter((call) => call[1] === "split").at(-1)!;
	const argv = split.slice(split.indexOf("--") + 1);
	return { path: argv[2], argv };
}

describe("Rex interactive launch integration", () => {
	it("launches with shared capsule, agent cwd and persisted backend; no shell staging or Herdr placement", async () => {
		const f = launchFixture();
		const running = await launchInteractiveSubagent(params, f.ctx, runtime);
		assert.equal(running.surface, REX_CHILD);
		assert.deepEqual(running.rexTarget, { sessionId: REX_SESSION, blockId: REX_CHILD, parentBlockId: REX_PARENT });
		assert.equal(readSubagentLaunchMetadataForTest(running.sessionFile)?.rexSessionId, REX_SESSION);
		assert.equal(running.launchMetadata?.muxBackend, "rex");
		assert.equal(readSubagentLaunchMetadataForTest(running.sessionFile)?.muxBackend, "rex");
		assert.equal(running.launchMetadata?.herdrPlacementPolicy, undefined);
		const { path, argv } = capsuleFrom(f.calls());
		try {
			const capsule = JSON.parse(readFileSync(path, "utf8"));
			assert.deepEqual(capsule.rexParent, { sessionId: REX_SESSION, blockId: REX_PARENT });
			assert.equal(capsule.cwd, f.childCwd);
			assert.equal(capsule.overrides.PI_SUBAGENT_SURFACE, undefined);
			assert.equal(capsule.overrides.PI_SUBAGENT_AGENT, "rex-worker");
			assert.equal(capsule.overrides.PI_SUBAGENT_INITIAL_TITLE, running.launchMetadata?.sessionTitle);
			assert.ok(capsule.args.includes("--approve"));
			assert.equal(argv.length, 3);
			const split = f.calls().find((call) => call[1] === "split")!;
			assert.equal(split[split.indexOf("-c") + 1], f.childCwd);
			assert.ok(!f.calls().some((call) => call.includes("send")));
		} finally { disposeEnvCapsule(path); }
	});

	it("resumes through native Rex argv and refuses persisted backend mismatch", async () => {
		const f = launchFixture();
		const first = await launchInteractiveSubagent(params, f.ctx, runtime);
		disposeEnvCapsule(capsuleFrom(f.calls()).path);
		const resumed = await resumeSubagentSession({ sessionFile: first.sessionFile, task: "Continue." }, resumeRuntime());
		assert.equal(resumed.surface, REX_CHILD);
		assert.deepEqual(resumed.rexTarget, { sessionId: REX_SESSION, blockId: REX_CHILD, parentBlockId: REX_PARENT });
		const capsule = capsuleFrom(f.calls());
		try {
			const data = JSON.parse(readFileSync(capsule.path, "utf8"));
			assert.deepEqual(data.rexParent, { sessionId: REX_SESSION, blockId: REX_PARENT });
			assert.ok(data.args.includes(first.sessionFile));
		} finally { disposeEnvCapsule(capsule.path); }
		process.env.PI_SUBAGENT_MUX = "herdr";
		await assert.rejects(resumeSubagentSession({ sessionFile: first.sessionFile }, resumeRuntime()), /Cannot resume rex child/);
	});

	it("persists standalone ownership before launch and guards its resume backend", async () => {
		const f = launchFixture();
		const definition = join(f.cwd, ".pi", "agents", "rex-worker.md");
		writeFileSync(definition, readFileSync(definition, "utf8").replace("auto-exit: true", "auto-exit: true\nsession-mode: standalone"));
		const first = await launchInteractiveSubagent(params, f.ctx, runtime);
		disposeEnvCapsule(capsuleFrom(f.calls()).path);
		const saved = readSubagentLaunchMetadataForTest(first.sessionFile);
		assert.equal(saved?.sessionMode, "standalone");
		assert.equal(saved?.muxBackend, "rex");
		assert.equal(saved?.rexSessionId, REX_SESSION);
		assert.equal(JSON.parse(readFileSync(first.sessionFile, "utf8").split("\n")[0]).parentSession, undefined);
		const resumed = await resumeSubagentSession({ sessionFile: first.sessionFile, task: "Continue." }, resumeRuntime());
		assert.equal(resumed.rexTarget?.sessionId, REX_SESSION);
		disposeEnvCapsule(capsuleFrom(f.calls()).path);
		process.env.PI_SUBAGENT_MUX = "herdr";
		await assert.rejects(resumeSubagentSession({ sessionFile: first.sessionFile }, resumeRuntime()), /Cannot resume rex child/);
	});

	it("refuses resuming a saved Rex child from another project session", async () => {
		const f = launchFixture();
		const running = await launchInteractiveSubagent(params, f.ctx, runtime);
		disposeEnvCapsule(capsuleFrom(f.calls()).path);
		const before = f.calls().filter((call) => call[1] === "split").length;
		const text = readFileSync(running.sessionFile, "utf8");
		const original = `"rexSessionId":"${REX_SESSION}"`;
		assert.ok(text.includes(original));
		writeFileSync(running.sessionFile, text.replaceAll(original, '"rexSessionId":"session:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"'));
		await assert.rejects(resumeSubagentSession({ sessionFile: running.sessionFile }, resumeRuntime()), /different Rex session/);
		assert.equal(f.calls().filter((call) => call[1] === "split").length, before);
	});

	it("runtime kill closes recorded child after parent block disappears", async () => {
		const f = launchFixture();
		const running = await launchInteractiveSubagent(params, f.ctx, runtime);
		disposeEnvCapsule(capsuleFrom(f.calls()).path);
		f.setState({ parentGone: true });
		delete process.env.REX_SESSION;delete process.env.REX_BLOCK;
		await stopRunningSubagent(running);
		assert.equal(running.surface, undefined);
		assert.ok(f.calls().some((args) => args[1] === "block" && args[2] === "close" && args[3] === REX_CHILD));
	});

	it("timeout replacement retains fresh Rex ownership and launch title", async () => {
		const f = launchFixture();
		const running = await launchInteractiveSubagent(params, f.ctx, runtime);
		disposeEnvCapsule(capsuleFrom(f.calls()).path);
		running.timeoutWrapUp = { kind: "timeout", seconds: 10, threshold: 80 };
		await restartSubagentForTimeoutWrapUp(running, runtime);
		const capsule = capsuleFrom(f.calls());
		try {
			assert.deepEqual(running.rexTarget, { sessionId: REX_SESSION, blockId: REX_CHILD, parentBlockId: REX_PARENT });
			const data = JSON.parse(readFileSync(capsule.path, "utf8"));
			assert.equal(data.overrides.PI_SUBAGENT_INITIAL_TITLE, running.launchMetadata?.sessionTitle);
			assert.equal(data.overrides.PI_SUBAGENT_TIMEOUT_WRAP_UP, "1");
		} finally { disposeEnvCapsule(capsule.path); }
	});

	it("disposes private capsule when native creation fails", async () => {
		const f = launchFixture();f.setState({ splitFail: true });
		const root = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR!;
		const before = new Set(readdirSync(root));
		await assert.rejects(launchInteractiveSubagent(params, f.ctx, runtime));
		assert.deepEqual(readdirSync(root).filter((name) => !before.has(name)), []);
	});

	it("runner derives new child identity, protects it from overrides, and preserves argv/environment", () => {
		const f = useFakeRex();
		const output = join(f.dir, "child-output.json");
		const script = join(f.dir, "child.mjs");
		writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2), block:process.env.REX_BLOCK, session:process.env.REX_SESSION, surface:process.env.PI_SUBAGENT_SURFACE, mux:process.env.PI_SUBAGENT_MUX, herdr:process.env.HERDR_ENV, value:process.env.TEST_VALUE}));`);
		const previous = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = `${process.execPath} ${script}`;
		try {
			const launch = buildInteractiveShellCommand({ cwd: f.dir, piArgs: ["quoted ' value", "$(not shell)"],
				envOverrides: { TEST_VALUE: "value with spaces", REX_BLOCK: REX_PARENT, HERDR_ENV: "1", PI_SUBAGENT_SURFACE: REX_PARENT },
				doneSentinelFile: join(f.dir, "done"), rexParent: { sessionId: REX_SESSION, blockId: REX_PARENT } });
			const result = spawnSync(launch.argv[0], launch.argv.slice(1), { encoding: "utf8", env: { PATH: f.dir, REX_SESSION, REX_BLOCK: REX_CHILD } });
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { cwd: realpathSync(f.dir), args: ["quoted ' value", "$(not shell)"],
				block: REX_CHILD, session: REX_SESSION, surface: REX_CHILD, mux: "rex", value: "value with spaces" });
			assert.equal(existsSync(launch.capsulePath), false);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND; else process.env.PI_SUBAGENT_PI_COMMAND = previous;
			rmSync(output, { force: true });
		}
	});

	it("runner refuses inherited parent block or wrong session before starting Pi", () => {
		const f = useFakeRex();
		for (const env of [{ REX_SESSION, REX_BLOCK: REX_PARENT }, { REX_SESSION: "other", REX_BLOCK: REX_CHILD }]) {
			const launch = buildInteractiveShellCommand({ cwd: f.dir, piArgs: [], envOverrides: {}, doneSentinelFile: join(f.dir, "done"),
				rexParent: { sessionId: REX_SESSION, blockId: REX_PARENT } });
			const result = spawnSync(launch.argv[0], launch.argv.slice(1), { encoding: "utf8", env });
			assert.equal(result.status, 2);
			assert.match(result.stderr, /invalid Rex child identity/);
			assert.equal(existsSync(launch.capsulePath), false);
		}
	});
});
