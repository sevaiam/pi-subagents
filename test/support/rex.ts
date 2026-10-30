import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDir } from "./fixtures.ts";

export const REX_SESSION = "session:11111111-1111-4111-8111-111111111111";
export const REX_PARENT = "block:22222222-2222-4222-8222-222222222222";
export const REX_CHILD = "block:33333333-3333-4333-8333-333333333333";
export const REX_WINDOW = "window:44444444-4444-4444-8444-444444444444";

/** Fake CLI is the only executable on PATH. No test can contact a live mux. */
export function useFakeRex() {
	const dir = createTestDir();
	const log = join(dir, "commands.jsonl");
	const state = join(dir, "state.json");
	writeFileSync(log, "");
	writeFileSync(state, "{}");
	const script = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const json = value => console.log(JSON.stringify(value));
if (args[0] !== '--autostart=false' || args[args.indexOf('-s') + 1] !== ${JSON.stringify(REX_SESSION)}) process.exit(90);
const op = args[1];
if (op === 'block' && args[2] === 'inspect') {
 if (state.lookupFail || (state.parentGone && args[3] === ${JSON.stringify(REX_PARENT)})) process.exit(3);
 if (state.malformed) { console.log('not-json'); process.exit(0); }
 json({session_id:state.wrongSession ? 'other' : ${JSON.stringify(REX_SESSION)}, block:{block_id:state.wrongBlock ? 'other' : args[3], window_id:${JSON.stringify(REX_WINDOW)},label:state.label ?? 'Manual title'}});
} else if (op === 'split') {
 if (state.splitFail) process.exit(3);
 json({session_id:${JSON.stringify(REX_SESSION)},anchor_id:state.badAnchor ? 'other' : args[args.indexOf('-b')+1],block_ids:[state.parentAsChild ? ${JSON.stringify(REX_PARENT)} : ${JSON.stringify(REX_CHILD)}]});
} else if (op === 'capture') {
 if (state.captureFail) process.exit(3);
 setTimeout(() => console.log(state.screen ?? 'line one\\nline two'), state.captureDelay ?? 0);
} else if (op === 'wait') {
 fs.writeFileSync(${JSON.stringify(join(dir, "wait.pid"))}, String(process.pid));
 if (state.waitSidecar) fs.writeFileSync(state.waitSidecar, JSON.stringify({type:'done',outputTokens:9}));
 if (state.waitHang) { if (state.ignoreTerm) process.on('SIGTERM',()=>{});setInterval(()=>{}, 1000); }
 else if (state.waitError) { console.error('server disconnected'); process.exit(1); }
 else if (state.waitMalformed) { console.log('broken json'); process.exit(0); }
 else if (state.waitPayload) {json(state.waitPayload);process.exit(state.waitCode ?? 0);}
 else {json({exit_code:state.exitCode || 0});process.exit((state.exitCode || 0) % 256);}
} else if (op === 'send' || op === 'send-key' || (op === 'block' && ['rename','close'].includes(args[2]))) {
 if (state.controlFail) process.exit(3);
 if (args[2] === 'rename') {state.label=args.at(-1);fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(state));}
} else process.exit(91);
`;
	const exe = join(dir, "rex");
	writeFileSync(exe, script);chmodSync(exe, 0o700);
	for (const key of Object.keys(process.env)) {
		if (/^(HERDR|CMUX|TMUX|WEZTERM|ZELLIJ|REX)/.test(key)) delete process.env[key];
	}
	process.env.REX_SESSION = REX_SESSION;
	process.env.REX_BLOCK = REX_PARENT;
	delete process.env.PI_SUBAGENT_MUX;
	process.env.PATH = dir;
	return { dir, state, calls: (): string[][] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
		setState: (value: Record<string, unknown>) => writeFileSync(state, JSON.stringify(value)) };
}
