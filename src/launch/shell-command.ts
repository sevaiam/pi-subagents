import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellEscape } from "../mux.ts";
import { getInteractiveProcessFile } from "../session/interactive-process.ts";
import { getPiInvocation, resolveRuntimeExecutable } from "./child-command.ts";
import { buildParentEnvSnapshot, PANE_IDENTITY_ENV_PATTERNS, resolveDenyEnvPatterns } from "./child-env.ts";
import { disposeEnvCapsule, writeEnvCapsule } from "./env-capsule.ts";
import { buildInteractiveSentinelShellCommands } from "./interactive-sentinel.ts";
import { buildShellChangeDirectoryPrefix } from "./resume.ts";

export interface InteractiveShellCommandInput {
	cwd?: string;
	/** Raw pi argv (unescaped); the capsule carries it as structured data. */
	piArgs: string[];
	/** Controlled launch overrides: frontmatter `env:` plus PI_* control vars. */
	envOverrides: Record<string, string>;
	/** Agent frontmatter `deny-env` spec; unioned with PI_SUBAGENT_ENV_DENY. */
	denyEnv?: string;
	doneSentinelFile: string;
	/** Derive PI_SUBAGENT_SURFACE from the child pane's ZELLIJ_PANE_ID. */
	deriveZellijPaneSurface?: boolean;
	rexParent?: { sessionId: string; blockId: string };
}

export interface InteractiveShellCommand {
	/** The string typed or staged into the child pane. Paths only — never env data. */
	command: string;
	/** Native mux launch argv. Environment and Pi args remain in the private capsule. */
	argv: string[];
	capsulePath: string;
	/**
	 * Idempotent cleanup for failed launches and finished/stopped supervision.
	 * Keep it on RunningSubagent until the child consumes the capsule or finishes.
	 */
	dispose: () => void;
}

export function getRunChildLauncherPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "run-child.mjs");
}

/**
 * Build the single interactive launch command used by initial launch, resume,
 * and timeout wrap-up.
 *
 * The observable pane command carries only the sentinel trap, the cd prefix,
 * and two paths (launcher + capsule). The pi argv and the environment travel
 * inside the one-shot capsule, which the launcher unlinks before spawning.
 */
export function buildInteractiveShellCommand(input: InteractiveShellCommandInput): InteractiveShellCommand {
	// Resolve the launcher and inferred Pi runtime before writing inherited environment.
	// Explicit PI_SUBAGENT_PI_COMMAND wrappers keep their existing invocation contract.
	const runtime = resolveRuntimeExecutable();
	const invocation = getPiInvocation(input.piArgs);
	const capsulePath = writeEnvCapsule({
		command: invocation.command,
		args: invocation.args,
		...(input.cwd ? { cwd: input.cwd } : {}),
		parentEnv: buildParentEnvSnapshot(process.env, resolveDenyEnvPatterns(input.denyEnv)),
		overrides: input.envOverrides,
		paneIdentityKeys: [...PANE_IDENTITY_ENV_PATTERNS],
		processIdFile: getInteractiveProcessFile(input.doneSentinelFile),
		...(input.deriveZellijPaneSurface ? { deriveZellijPaneSurface: true } : {}),
		...(input.rexParent ? { rexParent: input.rexParent } : {}),
	});
	const sentinel = buildInteractiveSentinelShellCommands(input.doneSentinelFile);
	const launcher = `${shellEscape(runtime)} ${shellEscape(getRunChildLauncherPath())} ${shellEscape(capsulePath)}`;
	const command =
		`trap ${shellEscape(sentinel.exitTrap)} EXIT; ` +
		`${buildShellChangeDirectoryPrefix(input.cwd)}${launcher}; ${sentinel.direct}`;
	return { command, argv: [runtime, getRunChildLauncherPath(), capsulePath], capsulePath,
		dispose: () => disposeEnvCapsule(capsulePath) };
}
