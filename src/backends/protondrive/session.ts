import type { BackendSecretStore } from "../../backend-api";
import { failBackend } from "../shared/error-shape";

declare const sessionUidBrand: unique symbol;
declare const accessTokenBrand: unique symbol;
declare const refreshTokenBrand: unique symbol;
declare const keyPasswordBrand: unique symbol;

export type SessionUid = string & { readonly [sessionUidBrand]: true };
export type AccessToken = string & { readonly [accessTokenBrand]: true };
export type RefreshToken = string & { readonly [refreshTokenBrand]: true };
/** Passphrase for the account's user keys; decrypts every address key. */
export type KeyPassword = string & { readonly [keyPasswordBrand]: true };

export interface SessionTokens {
	readonly uid: SessionUid;
	readonly accessToken: AccessToken;
	readonly refreshToken: RefreshToken;
}

export interface ProtonSession extends SessionTokens {
	readonly keyPassword: KeyPassword;
}

/** The module's only credential key: one JSON-encoded {@link ProtonSession}. */
export const SESSION_SECRET_KEY = "session";

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** `null` when any field is missing. */
export function parseSessionTokens(raw: {
	readonly UID?: unknown;
	readonly AccessToken?: unknown;
	readonly RefreshToken?: unknown;
}): SessionTokens | null {
	if (!nonEmpty(raw.UID) || !nonEmpty(raw.AccessToken) || !nonEmpty(raw.RefreshToken)) return null;
	return {
		uid: raw.UID as SessionUid,
		accessToken: raw.AccessToken as AccessToken,
		refreshToken: raw.RefreshToken as RefreshToken,
	};
}

export function parseKeyPassword(value: unknown): KeyPassword | null {
	return nonEmpty(value) ? (value as KeyPassword) : null;
}

function parseStoredSession(raw: string | null): ProtonSession | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const tokens = parseSessionTokens({
		UID: record.uid,
		AccessToken: record.accessToken,
		RefreshToken: record.refreshToken,
	});
	const keyPassword = parseKeyPassword(record.keyPassword);
	return tokens && keyPassword ? { ...tokens, keyPassword } : null;
}

export async function saveSession(secrets: BackendSecretStore, session: ProtonSession): Promise<void> {
	await secrets.set(SESSION_SECRET_KEY, JSON.stringify(session));
}

export async function loadSession(secrets: BackendSecretStore): Promise<ProtonSession | null> {
	return parseStoredSession(await secrets.get(SESSION_SECRET_KEY));
}

/** `null` means Proton rejected the refresh token. */
export type TokenRefresher = (tokens: SessionTokens) => Promise<SessionTokens | null>;

/**
 * The live session of one connection. Refresh is single-flight and re-reads
 * SecretStorage first: another connection of this module may already have rotated
 * the refresh token, and Proton rejects a replayed one.
 */
export class SessionHandle {
	private inFlight: Promise<void> | null = null;

	private constructor(
		private readonly secrets: BackendSecretStore,
		private session: ProtonSession,
	) {}

	static async open(secrets: BackendSecretStore): Promise<SessionHandle> {
		const session = await loadSession(secrets);
		if (!session) failBackend("auth", "Not signed in to Proton Drive");
		return new SessionHandle(secrets, session);
	}

	get current(): ProtonSession {
		return this.session;
	}

	/** Replace `rejected`'s tokens; throws an `auth` error when Proton refuses the refresh. */
	refresh(rejected: AccessToken, refresher: TokenRefresher): Promise<void> {
		if (this.session.accessToken !== rejected) return Promise.resolve();
		this.inFlight ??= this.performRefresh(rejected, refresher).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async performRefresh(rejected: AccessToken, refresher: TokenRefresher): Promise<void> {
		const stored = await loadSession(this.secrets);
		if (stored && stored.accessToken !== rejected) {
			this.session = stored;
			return;
		}
		const tokens = await refresher(this.session);
		if (!tokens) failBackend("auth", "Proton Drive session expired. Please reconnect.");
		this.session = { ...tokens, keyPassword: this.session.keyPassword };
		await saveSession(this.secrets, this.session);
	}
}
