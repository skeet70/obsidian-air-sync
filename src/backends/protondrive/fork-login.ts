import type { BackendSecretStore } from "../../backend-api";
import { failBackend } from "../shared/error-shape";
import { PROTON_ACCOUNT_BASE, PROTON_AUTH_CLIENT_ID } from "./constants";
import type { KeyPassword, ProtonSession } from "./session";
import { parseKeyPassword, parseSessionTokens } from "./session";
import type { ProtonTransport } from "./transport";
import { ProtonApiError } from "./transport";

declare const forkSelectorBrand: unique symbol;
declare const forkKeyBrand: unique symbol;
/** Bearer for the forked session's tokens until the fork is consumed. */
type ForkSelector = string & { readonly [forkSelectorBrand]: true };
/** Base64 AES-256-GCM key the account page encrypts the key password with. */
type ForkKey = string & { readonly [forkKeyBrand]: true };

/** A sign-in the user has started in the browser; kept in SecretStorage between `start` and `complete`. */
interface PendingFork {
	readonly selector: ForkSelector;
	readonly key: ForkKey;
	readonly expiresAtMs: number;
}

export const FORK_SECRET_KEY = "pending-fork";

/** Proton's own polling schedule for this flow (`proton-drive-sdk-account/authWeb.ts`). */
const FORK_POLL_INTERVAL_MS = 5_000;
const FORK_MAX_POLL_TIME_MS = 10 * 60 * 1000;
const GCM_NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;

/** A 4xx that means Proton will never release this fork; 422 means the user has not signed in yet. */
function isForkRejection(status: number): boolean {
	return status >= 400 && status < 500 &&
		status !== HTTP_REQUEST_TIMEOUT && status !== HTTP_UNPROCESSABLE && status !== HTTP_TOO_MANY_REQUESTS;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function parsePendingFork(raw: string | null): PendingFork | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<Record<keyof PendingFork, unknown>>;
		if (typeof value.selector !== "string" || typeof value.key !== "string" || typeof value.expiresAtMs !== "number") {
			return null;
		}
		return { selector: value.selector as ForkSelector, key: value.key as ForkKey, expiresAtMs: value.expiresAtMs };
	} catch {
		return null;
	}
}

export interface ForkStart {
	readonly signInUrl: string;
	readonly expiresAtMs: number;
}

/**
 * Open a session fork and return the account-page URL the user signs in on. The
 * account page (not Air Sync) collects the password, 2FA and any CAPTCHA. The
 * new fork replaces any pending one.
 */
export async function beginFork(transport: ProtonTransport, secrets: BackendSecretStore, nowMs: number): Promise<ForkStart> {
	const response = await transport.json("GET", "auth/v4/sessions/forks");
	const selector = response.Selector;
	const userCode = response.UserCode;
	if (typeof selector !== "string" || typeof userCode !== "string") {
		failBackend("permanent", "Proton did not return a sign-in code");
	}
	const key = toBase64(crypto.getRandomValues(new Uint8Array(32))) as ForkKey;
	const pending: PendingFork = { selector: selector as ForkSelector, key, expiresAtMs: nowMs + FORK_MAX_POLL_TIME_MS };
	await secrets.set(FORK_SECRET_KEY, JSON.stringify(pending));
	const payload = `0:${userCode}:${key}:${PROTON_AUTH_CLIENT_ID}`;
	return {
		signInUrl: `${PROTON_ACCOUNT_BASE}/desktop/login?app=drive&pv=3#payload=${encodeURIComponent(payload)}`,
		expiresAtMs: pending.expiresAtMs,
	};
}

/** Delete the stored fork only if it is still `fork`. */
async function discardFork(secrets: BackendSecretStore, fork: PendingFork): Promise<void> {
	if (parsePendingFork(await secrets.get(FORK_SECRET_KEY))?.selector === fork.selector) {
		await secrets.delete(FORK_SECRET_KEY);
	}
}

async function decryptKeyPassword(key: ForkKey, payload: string): Promise<KeyPassword> {
	const blob = fromBase64(payload);
	if (blob.length < GCM_NONCE_LENGTH + GCM_TAG_LENGTH) failBackend("permanent", "Proton sign-in payload is truncated");
	const aesKey = await crypto.subtle.importKey("raw", fromBase64(key), "AES-GCM", false, ["decrypt"]);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: blob.subarray(0, GCM_NONCE_LENGTH), additionalData: new TextEncoder().encode("fork") },
		aesKey,
		blob.subarray(GCM_NONCE_LENGTH),
	);
	const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { keyPassword?: unknown };
	const keyPassword = parseKeyPassword(parsed.keyPassword);
	if (!keyPassword) failBackend("permanent", "Proton sign-in payload has no key password");
	return keyPassword;
}

export interface ForkClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

/**
 * Poll the stored fork until the user finishes signing in, then consume it. Each poll re-reads
 * the fork, so a sign-in restarted meanwhile is the one polled. The fork is deleted once Proton
 * releases it, on expiry, or when Proton rejects it; any other failure keeps it.
 */
export async function completeFork(
	transport: ProtonTransport,
	secrets: BackendSecretStore,
	clock: ForkClock,
): Promise<ProtonSession> {
	for (;;) {
		const pending = parsePendingFork(await secrets.get(FORK_SECRET_KEY));
		if (!pending) failBackend("auth", "No Proton sign-in is in progress. Click Connect again.");
		if (clock.now() > pending.expiresAtMs) {
			await discardFork(secrets, pending);
			failBackend("auth", "Proton sign-in timed out. Click Connect again.");
		}
		let response;
		try {
			response = await transport.json("GET", `auth/v4/sessions/forks/${encodeURIComponent(pending.selector)}`);
		} catch (err) {
			if (!(err instanceof ProtonApiError)) throw err;
			if (err.status === HTTP_UNPROCESSABLE) {
				await clock.sleep(FORK_POLL_INTERVAL_MS);
				continue;
			}
			if (isForkRejection(err.status)) {
				await discardFork(secrets, pending);
				failBackend("auth", `Proton rejected the sign-in (${err.message}). Click Connect again.`);
			}
			throw err;
		}
		await discardFork(secrets, pending);
		const tokens = parseSessionTokens(response);
		if (!tokens || typeof response.Payload !== "string") {
			failBackend("permanent", "Proton returned an incomplete session");
		}
		const keyPassword = await decryptKeyPassword(pending.key, response.Payload);
		return { ...tokens, keyPassword };
	}
}
