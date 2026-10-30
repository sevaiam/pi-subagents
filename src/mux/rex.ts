import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION = new RegExp(`^session:${UUID}$`, "i");
const BLOCK = new RegExp(`^block:${UUID}$`, "i");
const WINDOW = new RegExp(`^window:${UUID}$`, "i");
const OPTIONS = { encoding: "utf8" as const, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 };

export interface RexTarget {
	sessionId: string;
	blockId: string;
}

/** Captured at creation, never reconstructed from a focused block or a later caller. */
export interface RexChildTarget extends RexTarget {
	parentBlockId: string;
}

export function rexChildTarget(parent: RexTarget, blockId: string): RexChildTarget {
	if (!SESSION.test(parent.sessionId) || !BLOCK.test(parent.blockId) || !BLOCK.test(blockId) || blockId === parent.blockId) {
		throw new Error("Invalid Rex child ownership");
	}
	return { sessionId: parent.sessionId, blockId, parentBlockId: parent.blockId };
}

export function rexCaller(env: NodeJS.ProcessEnv = process.env): RexTarget | null {
	if (!SESSION.test(env.REX_SESSION ?? "") || !BLOCK.test(env.REX_BLOCK ?? "")) return null;
	if (["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID"].some((key) => env[key] !== undefined)) return null;
	return { sessionId: env.REX_SESSION!, blockId: env.REX_BLOCK! };
}

function scopedArgs(target: RexTarget, args: string[]): string[] {
	if (!SESSION.test(target.sessionId) || !BLOCK.test(target.blockId)) throw new Error("Invalid Rex session/block identity");
	return ["--autostart=false", ...args, "-s", target.sessionId];
}

function json(target: RexTarget, args: string[]): any {
	return JSON.parse(execFileSync("rex", scopedArgs(target, args), OPTIONS));
}

export function inspectRexBlock(target: RexTarget): { block_id: string; window_id: string; label?: string } {
	const value = json(target, ["block", "inspect", target.blockId, "--json"]);
	if (value?.session_id !== target.sessionId || value?.block?.block_id !== target.blockId ||
		!WINDOW.test(value?.block?.window_id ?? "")) {
		throw new Error("Rex did not return the requested block in its owning session");
	}
	return value.block;
}

export function requireRexCaller(): RexTarget {
	const target = rexCaller();
	if (!target) throw new Error("Rex requires an unambiguous REX_SESSION and REX_BLOCK; no backend fallback is allowed");
	inspectRexBlock(target);
	return target;
}

export function isRexRuntimeAvailable(hasCommand: (command: string) => boolean): boolean {
	if (!rexCaller() || !hasCommand("rex")) return false;
	try { requireRexCaller(); return true; } catch { return false; }
}

function childTarget(surface: string, owned?: RexChildTarget): RexTarget {
	let target: RexTarget;
	if (owned) {
		// Saved ownership allows cleanup after the parent has gone. Validate the child, not the parent.
		rexChildTarget({ sessionId: owned.sessionId, blockId: owned.parentBlockId }, owned.blockId);
		if (surface !== owned.blockId) throw new Error("Rex child surface does not match saved ownership");
		target = owned;
	} else {
		const caller = requireRexCaller();
		if (surface === caller.blockId) throw new Error("Refusing to control the Rex caller's own block as a child");
		target = { sessionId: caller.sessionId, blockId: surface };
	}
	inspectRexBlock(target);
	return target;
}

/** Start the existing capsule runner directly. No shell input, startup delay, or focus transaction. */
export function createRexCommandSurface(
	name: string,
	argv: string[],
	cwd: string,
	direction: "left" | "right" | "up" | "down" = "right",
	fromSurface?: string,
): string {
	const caller = requireRexCaller();
	const anchor = fromSurface ? { ...caller, blockId: fromSurface } : caller;
	inspectRexBlock(anchor);
	if (argv.length === 0) throw new Error("Rex child launch requires an explicit command");
	const splitDirection = direction === "up" ? "above" : direction === "down" ? "below" : direction;
	const args = scopedArgs(anchor, ["split", "-b", anchor.blockId, "--split", splitDirection,
		"--focus=false", "--keep-open", "--shell=none", "--label", name, "-c", cwd, "--json"]);
	const result = JSON.parse(execFileSync("rex", [...args, "--", ...argv], OPTIONS));
	const surface = result?.block_ids?.[0];
	if (!BLOCK.test(surface ?? "") || surface === anchor.blockId || result?.anchor_id !== anchor.blockId ||
		(result.session_id !== undefined && result.session_id !== caller.sessionId)) {
		// Never guess a target or retry a creation with an ambiguous result.
		throw new Error("Rex split returned an invalid child/anchor identity; inspect Rex before retrying");
	}
	return surface;
}

export function sendRexCommand(surface: string, command: string, owned?: RexChildTarget): void {
	const target = childTarget(surface, owned);
	if (command) execFileSync("rex", [...scopedArgs(target, ["send", "-b", surface]), "--", command], OPTIONS);
	execFileSync("rex", scopedArgs(target, ["send-key", "-b", surface, "enter"]), OPTIONS);
}

export function readRexScreen(surface: string, owned?: RexChildTarget): string {
	const target = childTarget(surface, owned);
	return execFileSync("rex", scopedArgs(target, ["capture", "-b", surface, "--trim", "--unwrap"]), OPTIONS);
}

export async function readRexScreenAsync(surface: string, owned?: RexChildTarget): Promise<string> {
	const target = childTarget(surface, owned);
	const { stdout } = await execAsync("rex", scopedArgs(target, ["capture", "-b", surface, "--trim", "--unwrap"]), OPTIONS);
	return stdout;
}

export function closeRexSurface(surface: string, owned?: RexChildTarget): void {
	const target = childTarget(surface, owned);
	execFileSync("rex", scopedArgs(target, ["block", "close", surface]), OPTIONS);
}

/** rex wait is event-driven and returns the terminal process exit status, including with --keep-open. */
export async function waitForRexExit(surface: string, signal: AbortSignal, owned?: RexChildTarget): Promise<number> {
	const target = childTarget(surface, owned);
	if (signal.aborted) throw new Error("Aborted while waiting for Rex child");
	const pending = execAsync("rex", scopedArgs(target, ["wait", surface, "--json"]), {
		encoding: "utf8", signal, maxBuffer: 1024 * 1024,
	});
	const closed = new Promise<void>((resolve) => pending.child.once("close", () => resolve()));
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => { killTimer = setTimeout(() => pending.child.kill("SIGKILL"), 250); };
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	let stdout: string;
	let code = 0;
	try {
		({ stdout } = await pending);
	} catch (error) {
		if (signal.aborted) throw new Error("Aborted while waiting for Rex child");
		const failure = error as { code?: unknown; stdout?: string; stderr?: string };
		if (typeof failure.code !== "number" || !failure.stdout?.trim()) throw error;
		stdout = failure.stdout;
		code = failure.code;
	} finally {
		// Abort settles execFile's promise before close. Wait for reaping, including a stubborn CLI.
		await closed;
		clearTimeout(killTimer);
		signal.removeEventListener("abort", onAbort);
	}
	const payload = JSON.parse(stdout.trim());
	// A terminal failure may include an `error` string alongside exit_code. API error envelopes do not.
	if (!Number.isSafeInteger(payload?.exit_code) || payload.exit_code < 0 || payload.exit_code % 256 !== code) {
		throw new Error("Rex wait did not report a valid matching terminal exit status");
	}
	return code;
}

const managedChildTitles = new Map<string, string>();
const titleBody = (title: string) => title.replace(/^(?:\[[^\]]+\]\s*)+/, "").trim();

/** Optional title tool changes only its launch-owned label, preserving manual edits and existing tags. */
export function renameRexChild(title: string): boolean {
	const caller = requireRexCaller();
	if (!process.env.PI_SUBAGENT_NAME || process.env.PI_SUBAGENT_SURFACE !== caller.blockId) return false;
	const current = inspectRexBlock(caller).label ?? "";
	const key = `${caller.sessionId}:${caller.blockId}`;
	const expected = managedChildTitles.get(key) ?? process.env.PI_SUBAGENT_INITIAL_TITLE;
	if (expected === undefined || titleBody(current) !== titleBody(expected)) return false;
	const tags = current.match(/^(?:\[[^\]]+\]\s*)+/)?.[0].trim();
	const next = tags ? `${tags} ${titleBody(title)}`.trim() : title.trim();
	execFileSync("rex", [...scopedArgs(caller, ["block", "rename"]), "--", caller.blockId, next], OPTIONS);
	managedChildTitles.set(key, next);
	return true;
}
