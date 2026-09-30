import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BackendHttpClient, BackendHttpRequest, BackendSecretStore, JsonValue } from "../../backend-api";
import { FORK_SECRET_KEY, beginFork, completeFork } from "./fork-login";
import { ProtonTransport } from "./transport";

beforeAll(() => {
	vi.stubGlobal("window", { setTimeout, clearTimeout });
});

function memorySecrets(): BackendSecretStore & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return {
		values,
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

function reply(status: number, body: JsonValue) {
	const text = JSON.stringify(body);
	return {
		status,
		headers: { "content-type": "application/json" },
		text: () => Promise.resolve(text),
		arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
		json: () => Promise.resolve(body),
	};
}

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

/** What the account page does once the user signs in: AES-GCM over `{keyPassword}` with AAD "fork". */
async function encryptPayload(keyBase64: string, keyPassword: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0)), "AES-GCM", false, ["encrypt"]);
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode("fork") },
		key,
		new TextEncoder().encode(JSON.stringify({ type: "default", keyPassword })),
	);
	return base64(new Uint8Array([...nonce, ...new Uint8Array(sealed)]));
}

const clock = { now: () => 0, sleep: () => Promise.resolve() };

describe("Proton session-fork sign-in", () => {
	it("polls until the account page releases the fork, then returns the session with the decrypted key password", async () => {
		const secrets = memorySecrets();
		const requests: BackendHttpRequest[] = [];
		let polls = 0;
		const http: BackendHttpClient = {
			request: async (request) => {
				requests.push(request);
				if (request.url.endsWith("/auth/v4/sessions/forks")) {
					return reply(200, { Code: 1000, Selector: "SEL", UserCode: "CODE" });
				}
				polls++;
				if (polls < 3) return reply(422, { Code: 2501, Error: "not ready" });
				const pending = JSON.parse(secrets.values.get(FORK_SECRET_KEY) ?? "{}") as { key: string };
				return reply(200, {
					Code: 1000,
					UID: "UID",
					AccessToken: "AT",
					RefreshToken: "RT",
					Payload: await encryptPayload(pending.key, "the-key-password"),
				});
			},
		};
		const transport = new ProtonTransport(http, null);

		const { signInUrl } = await beginFork(transport, secrets, 0);
		const session = await completeFork(transport, secrets, clock);

		expect(signInUrl).toMatch(/^https:\/\/account\.proton\.me\/desktop\/login\?app=drive&pv=3#payload=0%3ACODE%3A.+%3Aexternal-drive$/);
		expect(session).toEqual({ uid: "UID", accessToken: "AT", refreshToken: "RT", keyPassword: "the-key-password" });
		expect(polls).toBe(3);
		expect(requests.every((request) => request.headers?.["x-pm-appversion"]?.startsWith("external-drive-air_sync@"))).toBe(true);
		expect(secrets.values.has(FORK_SECRET_KEY)).toBe(false);
	});

	it("gives up once the fork has expired and forgets it", async () => {
		const secrets = memorySecrets();
		const http: BackendHttpClient = {
			request: (request) =>
				Promise.resolve(
					request.url.endsWith("/auth/v4/sessions/forks")
						? reply(200, { Code: 1000, Selector: "SEL", UserCode: "CODE" })
						: reply(422, { Code: 2501 }),
				),
		};
		const transport = new ProtonTransport(http, null);
		await beginFork(transport, secrets, 0);
		let now = 0;

		await expect(
			completeFork(transport, secrets, { now: () => now, sleep: () => Promise.resolve(void (now += 60_000)) }),
		).rejects.toMatchObject({ kind: "auth" });
		expect(secrets.values.has(FORK_SECRET_KEY)).toBe(false);
	});

	it("keeps the fork across a transient poll failure so a later call completes the sign-in", async () => {
		const secrets = memorySecrets();
		let pollStatus = 503;
		const http: BackendHttpClient = {
			request: async (request) => {
				if (request.url.endsWith("/auth/v4/sessions/forks")) {
					return reply(200, { Code: 1000, Selector: "SEL", UserCode: "CODE" });
				}
				if (pollStatus !== 200) return reply(pollStatus, { Code: 0, Error: "unavailable" });
				const pending = JSON.parse(secrets.values.get(FORK_SECRET_KEY) ?? "{}") as { key: string };
				return reply(200, { Code: 1000, UID: "UID", AccessToken: "AT", RefreshToken: "RT", Payload: await encryptPayload(pending.key, "kp") });
			},
		};
		const transport = new ProtonTransport(http, null);
		await beginFork(transport, secrets, 0);

		await expect(completeFork(transport, secrets, clock)).rejects.toThrow();
		expect(secrets.values.has(FORK_SECRET_KEY)).toBe(true);

		pollStatus = 200;
		await expect(completeFork(transport, secrets, clock)).resolves.toMatchObject({ uid: "UID", keyPassword: "kp" });
		expect(secrets.values.has(FORK_SECRET_KEY)).toBe(false);
	});

	it("forgets a fork Proton rejects", async () => {
		const secrets = memorySecrets();
		const http: BackendHttpClient = {
			request: (request) =>
				Promise.resolve(
					request.url.endsWith("/auth/v4/sessions/forks")
						? reply(200, { Code: 1000, Selector: "SEL", UserCode: "CODE" })
						: reply(400, { Code: 2001, Error: "Invalid selector" }),
				),
		};
		const transport = new ProtonTransport(http, null);
		await beginFork(transport, secrets, 0);

		await expect(completeFork(transport, secrets, clock)).rejects.toMatchObject({ kind: "auth" });
		expect(secrets.values.has(FORK_SECRET_KEY)).toBe(false);
	});

	it("polls the sign-in restarted while it was waiting", async () => {
		const secrets = memorySecrets();
		const polled: string[] = [];
		let forks = 0;
		const http: BackendHttpClient = {
			request: async (request) => {
				if (request.url.endsWith("/auth/v4/sessions/forks")) {
					forks++;
					return reply(200, { Code: 1000, Selector: `SEL${forks}`, UserCode: "CODE" });
				}
				polled.push(request.url.slice(request.url.lastIndexOf("/") + 1));
				if (forks < 2) return reply(422, { Code: 2501 });
				const pending = JSON.parse(secrets.values.get(FORK_SECRET_KEY) ?? "{}") as { key: string };
				return reply(200, { Code: 1000, UID: "UID", AccessToken: "AT", RefreshToken: "RT", Payload: await encryptPayload(pending.key, "kp") });
			},
		};
		const transport = new ProtonTransport(http, null);
		await beginFork(transport, secrets, 0);

		const session = await completeFork(transport, secrets, {
			now: () => 0,
			sleep: async () => {
				await beginFork(transport, secrets, 0);
			},
		});

		expect(session.keyPassword).toBe("kp");
		expect(polled).toEqual(["SEL1", "SEL2"]);
	});

	it("requires a started sign-in", async () => {
		const transport = new ProtonTransport({ request: () => Promise.reject(new Error("no request expected")) }, null);
		await expect(completeFork(transport, memorySecrets(), clock)).rejects.toMatchObject({ kind: "auth" });
	});
});
