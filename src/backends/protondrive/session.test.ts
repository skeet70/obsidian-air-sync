import { describe, expect, it, vi } from "vitest";
import type { BackendSecretStore } from "../../backend-api";
import type { ProtonSession, SessionTokens } from "./session";
import { SessionHandle, loadSession, parseSessionTokens, saveSession } from "./session";

function memorySecrets(): BackendSecretStore {
	const values = new Map<string, string>();
	return {
		get: (key) => Promise.resolve(values.get(key) ?? null),
		set: (key, value) => {
			values.set(key, value);
			return Promise.resolve();
		},
		delete: (key) => {
			values.delete(key);
			return Promise.resolve();
		},
	};
}

function session(generation: number): ProtonSession {
	const tokens = parseSessionTokens({ UID: "uid", AccessToken: `at-${generation}`, RefreshToken: `rt-${generation}` });
	if (!tokens) throw new Error("fixture");
	return { ...tokens, keyPassword: "kp" as ProtonSession["keyPassword"] };
}

function tokens(generation: number): SessionTokens {
	const { keyPassword: _unused, ...rest } = session(generation);
	return rest;
}

describe("SessionHandle.refresh", () => {
	it("adopts tokens another connection already rotated instead of replaying the old refresh token", async () => {
		const secrets = memorySecrets();
		await saveSession(secrets, session(1));
		const handle = await SessionHandle.open(secrets);
		await saveSession(secrets, session(2));
		const refresher = vi.fn();

		await handle.refresh(session(1).accessToken, refresher);

		expect(refresher).not.toHaveBeenCalled();
		expect(handle.current.accessToken).toBe(session(2).accessToken);
	});

	it("refreshes once for concurrent 401s and persists the rotated tokens with the key password", async () => {
		const secrets = memorySecrets();
		await saveSession(secrets, session(1));
		const handle = await SessionHandle.open(secrets);
		const refresher = vi.fn().mockResolvedValue(tokens(2));

		await Promise.all([
			handle.refresh(session(1).accessToken, refresher),
			handle.refresh(session(1).accessToken, refresher),
		]);

		expect(refresher).toHaveBeenCalledTimes(1);
		expect(await loadSession(secrets)).toEqual(session(2));
	});

	it("fails with an auth error and keeps the stored session when Proton rejects the refresh token", async () => {
		const secrets = memorySecrets();
		await saveSession(secrets, session(1));
		const handle = await SessionHandle.open(secrets);

		await expect(handle.refresh(session(1).accessToken, () => Promise.resolve(null))).rejects.toMatchObject({ kind: "auth" });
		expect(await loadSession(secrets)).toEqual(session(1));
	});

	it("refuses to open without a stored session", async () => {
		await expect(SessionHandle.open(memorySecrets())).rejects.toMatchObject({ kind: "auth" });
	});
});
