import { shouldUseBackgroundLaunch } from "../../src/launch/policy.ts";
import { assert, describe, it, createTestDir } from "../support/index.ts";
import { useFakeRex } from "../support/rex.ts";

const identities = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "REX_SESSION", "REX_BLOCK", "CMUX_SOCKET_PATH", "TMUX", "ZELLIJ", "ZELLIJ_SESSION_NAME", "WEZTERM_UNIX_SOCKET"];
function noMux() {
	for (const key of identities) delete process.env[key];
	delete process.env.PI_SUBAGENT_MUX;
	process.env.PATH = createTestDir();
}

describe("interactive mode invalid-context policy", () => {
	it("keeps deliberate no-mux and headless fallback, explicit background and verifier behavior", () => {
		noMux();
		assert.equal(shouldUseBackgroundLaunch({}, { mode: "interactive" }, true), true);
		process.env.REX_SESSION = "partial";
		assert.equal(shouldUseBackgroundLaunch({}, { mode: "interactive" }, false), true);
		assert.equal(shouldUseBackgroundLaunch({ background: true }, { mode: "interactive" }, true), true);
		assert.equal(shouldUseBackgroundLaunch({}, { mode: "background" }, true), true);
		assert.equal(shouldUseBackgroundLaunch({}, { mode: "interactive", llmAsVerifier: true }, true), true);
	});

	it("rejects partial, mixed, stale, malformed, missing CLI and invalid explicit preference", () => {
		for (const setup of [
			() => { noMux();process.env.REX_BLOCK = "partial"; },
			() => { useFakeRex();process.env.HERDR_ENV = "1"; },
			() => { useFakeRex().setState({ lookupFail: true }); },
			() => { useFakeRex();process.env.REX_BLOCK = "focused"; },
			() => { useFakeRex();process.env.PATH = createTestDir(); },
			() => { noMux();process.env.PI_SUBAGENT_MUX = "typo"; },
			() => { noMux();process.env.TMUX = "unavailable"; },
		]) {
			setup();
			assert.throws(() => shouldUseBackgroundLaunch({}, { mode: "interactive" }, true), /no background fallback/);
			assert.throws(() => shouldUseBackgroundLaunch({ background: false }, { mode: "background" }, true), /no background fallback/);
		}
	});

	it("keeps a valid Rex interactive launch interactive", () => {
		useFakeRex();
		assert.equal(shouldUseBackgroundLaunch({}, { mode: "interactive" }, true), false);
	});
});
