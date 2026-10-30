import { accessSync, constants, existsSync, statSync } from "node:fs";
import { basename, delimiter, join, resolve, win32 } from "node:path";
import { buildParentEnvSnapshot } from "./child-env.ts";

export interface PiInvocation {
	command: string;
	args: string[];
}

/**
 * Split a command override into argv parts. This intentionally supports only
 * shell-style quoting/escaping, not expansion or operators, because the result
 * is also used with spawn() for background subagents.
 */
export function parseCommandWords(command: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	for (const char of command.trim()) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if ((char === "'" || char === '"') && quote === null) {
			quote = char;
			continue;
		}
		if (char === quote) {
			quote = null;
			continue;
		}
		if (/\s/.test(char) && quote === null) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaping) current += "\\";
	if (quote !== null) throw new Error("PI_SUBAGENT_PI_COMMAND has an unterminated quote");
	if (current) words.push(current);
	return words;
}

/** Recover a removed Node/Bun executable without changing runtime family or evaluating a shell. */
export function resolveRuntimeExecutable(
	execPath = process.execPath,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	const executable = (path: string): boolean => {
		try {
			accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
			return statSync(path).isFile();
		} catch { return false; }
	};
	if (executable(execPath)) return execPath;
	const name = (platform === "win32" ? win32.basename(execPath) : basename(execPath)).toLowerCase();
	const family = /^(node|bun)(?:\.exe)?$/.exec(name)?.[1];
	if (family) {
		const extensions = platform === "win32"
			? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => /^\.(?:exe|com)$/i.test(ext))
			: [""];
		for (const entry of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
			const dir = entry.replace(/^"(.*)"$/, "$1");
			if (!dir) continue;
			for (const ext of extensions) {
				const candidate = resolve(join(dir, family + ext));
				if (executable(candidate)) return candidate;
			}
		}
	}
	throw new Error(`Subagent runtime is unavailable: ${execPath}. Restart Pi from an installed executable${family ? ` or put ${family} on PATH` : ""}. No child was launched.`);
}

/**
 * Resolve the correct pi binary path for spawn(). Handles node, bun,
 * bundled executables, and opt-in wrapper commands.
 */
export function getPiInvocation(args: string[]): PiInvocation {
	const override = process.env.PI_SUBAGENT_PI_COMMAND?.trim();
	if (override) {
		const parts = parseCommandWords(override);
		if (parts.length === 0) {
			throw new Error("PI_SUBAGENT_PI_COMMAND did not contain a command");
		}
		return { command: parts[0], args: [...parts.slice(1), ...args] };
	}

	const runtime = resolveRuntimeExecutable();
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: runtime, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: runtime, args };
	}
	throw new Error("Cannot locate the parent Pi script. Restart Pi from its installed entrypoint or set PI_SUBAGENT_PI_COMMAND explicitly; refusing to guess a different Pi binary.");
}

export function getSubagentChildProcessEnv(
	_invocation: PiInvocation,
	envVars: Record<string, string>,
	denyPatterns: string[] = [],
): NodeJS.ProcessEnv {
	// Background children get the same snapshot policy as interactive ones:
	// deny-filtered and stripped of shell bookkeeping the child recomputes.
	return { ...buildParentEnvSnapshot(process.env, denyPatterns), ...envVars };
}
