import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendRuntimeContext, BackendSecretStore } from "../../src/backend-api";
import { createHttpClient } from "../../src/fs/modules/http-host";
import { loadDotEnvE2e } from "./env";

/**
 * The Proton module's secrets (session tokens plus the user-key password) as a
 * gitignored JSON file, rewritten whenever the module saves a secret.
 */
export function protonSecretsPath(): string {
	loadDotEnvE2e();
	return resolve(process.cwd(), process.env.AIRSYNC_E2E_PROTONDRIVE_SECRETS ?? ".e2e-protondrive-secrets.json");
}

function fileSecrets(path: string): BackendSecretStore {
	const read = (): Record<string, string> =>
		existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
	const write = (values: Record<string, string>): void => writeFileSync(path, JSON.stringify(values, null, "\t"), { mode: 0o600 });
	return {
		get: (key) => Promise.resolve(read()[key] ?? null),
		set: (key, value) => {
			write({ ...read(), [key]: value });
			return Promise.resolve();
		},
		delete: (key) => {
			const { [key]: _removed, ...rest } = read();
			write(rest);
			return Promise.resolve();
		},
	};
}

/** The runtime context core would build for the module, over real HTTP and a file-backed secret store. */
export function protonRuntimeContext(path = protonSecretsPath()): BackendRuntimeContext {
	// Module code uses window timers, as it would inside Obsidian.
	if (typeof window === "undefined") Object.assign(globalThis, { window: globalThis });
	const log = (level: string) => (message: string) => {
		if (process.env.AIRSYNC_E2E_VERBOSE === "1") console.log(`[protondrive:${level}] ${message}`);
	};
	return {
		http: createHttpClient(),
		secrets: fileSecrets(path),
		logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
		auth: {
			openExternal: (url) => {
				console.log(`\nOpen this URL and sign in to Proton:\n\n${url}\n`);
				return Promise.resolve();
			},
		},
	};
}
