import { classifyHttpError } from "../backend-api/error-classification";
import type { AirSyncSettings } from "../settings";
import type { IBackendProvider } from "./backend";

/** `pendingAuthState` is the marker: the module's `auth.start` sets it and a successful `auth.complete` unsets it. */
export function hasPendingPollSignIn(provider: IBackendProvider, settings: AirSyncSettings): boolean {
	const marker = settings.backendData.pendingAuthState;
	return provider.auth.completion === "poll" &&
		typeof marker === "string" && marker !== "" &&
		!provider.hasCredentials();
}

/** A failed poll that a later resume may still complete: the provider was unreachable or throttled. */
export function isResumablePollFailure(provider: IBackendProvider, err: unknown): boolean {
	if (provider.auth.completion !== "poll") return false;
	const { kind } = provider.classifyError?.(err) ?? classifyHttpError(err);
	return kind === "transient" || kind === "rateLimit";
}
