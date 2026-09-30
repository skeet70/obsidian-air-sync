import type { BackendHttpClient, BackendHttpMethod, BackendHttpResponse, JsonValue } from "../../backend-api";
import { failBackend } from "../shared/error-shape";
import { PROTON_API_BASE, PROTON_APP_VERSION } from "./constants";
import type { SessionHandle, SessionTokens } from "./session";
import { parseSessionTokens } from "./session";

/** Proton's success codes in a JSON body (`1001` = accepted, finishes asynchronously). */
const OK_CODES: ReadonlySet<number> = new Set([1000, 1001]);
const HTTP_METHODS: Readonly<Record<string, true>> = { GET: true, POST: true, PUT: true, PATCH: true, DELETE: true };
const DEFAULT_TIMEOUT_MS = 30_000;
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

export class ProtonApiError extends Error {
	override readonly name = "ProtonApiError";

	constructor(
		readonly status: number,
		readonly code: number | undefined,
		message: string,
	) {
		super(message);
	}
}

export interface ProtonRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: ArrayBuffer | string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

function toMethod(method: string): BackendHttpMethod {
	const upper = method.toUpperCase();
	if (HTTP_METHODS[upper] !== true) failBackend("permanent", `Unsupported HTTP method ${method}`);
	return upper as BackendHttpMethod;
}

/**
 * `requestUrl` can be neither cancelled nor timed out, so the caller stops waiting
 * while the request itself runs to completion. The SDK retries on the
 * `TimeoutError`/`AbortError` names.
 */
function withDeadline<T>(work: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Request aborted", "AbortError"));
			return;
		}
		const onAbort = (): void => reject(new DOMException("Request aborted", "AbortError"));
		const timer = window.setTimeout(
			() => reject(new DOMException(`Request timed out after ${timeoutMs} ms`, "TimeoutError")),
			timeoutMs,
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		work.then(resolve, reject).finally(() => {
			window.clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		});
	});
}

/** Proton's own auth routes, which a 401 must not recurse into. */
function isAuthRoute(url: string): boolean {
	const path = new URL(url).pathname.toLowerCase();
	return path.startsWith("/auth/v4/refresh") || path.startsWith("/auth/v4/sessions") || path.startsWith("/core/v4/auth");
}

function jsonCode(body: JsonValue): number | undefined {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
	return typeof body.Code === "number" ? body.Code : undefined;
}

function jsonError(body: JsonValue): string | undefined {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
	return typeof body.Error === "string" ? body.Error : undefined;
}

/**
 * Every Proton request, authenticated or not, over the module's `requestUrl`
 * transport. With a session it sends the session headers and, on one 401,
 * refreshes the session and replays the request once.
 */
export class ProtonTransport {
	constructor(
		private readonly http: BackendHttpClient,
		private readonly session: SessionHandle | null,
	) {}

	async send(request: ProtonRequest): Promise<BackendHttpResponse> {
		const tokens = this.session?.current;
		const response = await this.dispatch(request, tokens);
		if (response.status !== 401 || !tokens || !this.session || isAuthRoute(request.url)) return response;
		await this.session.refresh(tokens.accessToken, (current) => this.refreshTokens(current));
		return this.dispatch(request, this.session.current);
	}

	/** A JSON API call; throws {@link ProtonApiError} unless the status and body `Code` are successes. */
	async json(method: BackendHttpMethod, path: string, body?: JsonValue): Promise<Readonly<Record<string, JsonValue>>> {
		const headers: Record<string, string> = { accept: "application/vnd.protonmail.v1+json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		const response = await this.send({
			url: `${PROTON_API_BASE}/${path}`,
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const parsed = await response.json().catch(() => null);
		const code = parsed === null ? undefined : jsonCode(parsed);
		if (response.status >= 400 || code === undefined || !OK_CODES.has(code)) {
			const detail = parsed === null ? undefined : jsonError(parsed);
			throw new ProtonApiError(response.status, code, `${method} ${path} failed (${response.status}${code === undefined ? "" : `/${code}`})${detail ? `: ${detail}` : ""}`);
		}
		return parsed as Readonly<Record<string, JsonValue>>;
	}

	/** Adapt an SDK request/response pair (`ProtonDriveHTTPClient`) onto {@link send}. */
	async fetch(request: {
		url: string;
		method: string;
		headers: Headers;
		json?: object;
		body?: XMLHttpRequestBodyInit;
		timeoutMs: number;
		signal?: AbortSignal;
	}): Promise<Response> {
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			headers[key] = value;
		});
		let body: ArrayBuffer | string | undefined;
		if (request.json !== undefined) {
			body = JSON.stringify(request.json);
		} else if (typeof request.body === "string" || request.body instanceof ArrayBuffer) {
			body = request.body;
		} else if (request.body !== undefined) {
			// FormData/Blob/views: let the platform serialize and pick the multipart boundary.
			const encoded = new Request(PROTON_API_BASE, { method: "POST", body: request.body });
			const type = encoded.headers.get("content-type");
			if (type && headers["content-type"] === undefined) headers["content-type"] = type;
			body = await encoded.arrayBuffer();
		}
		const response = await this.send({
			url: request.url,
			method: request.method,
			headers,
			body,
			timeoutMs: request.timeoutMs,
			signal: request.signal,
		});
		if (response.status < 200 || response.status > 599) {
			failBackend("transient", `Proton returned HTTP ${response.status}`);
		}
		const bytes = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
		return new Response(bytes, { status: response.status, headers: response.headers });
	}

	private dispatch(request: ProtonRequest, tokens: SessionTokens | undefined): Promise<BackendHttpResponse> {
		const headers: Record<string, string> = { ...request.headers, "x-pm-appversion": PROTON_APP_VERSION };
		if (tokens) {
			headers["x-pm-uid"] = tokens.uid;
			headers.authorization = `Bearer ${tokens.accessToken}`;
		}
		const work = this.http.request({
			url: request.url,
			method: toMethod(request.method),
			headers,
			body: request.body,
		});
		return withDeadline(work, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, request.signal);
	}

	private async refreshTokens(tokens: SessionTokens): Promise<SessionTokens | null> {
		const response = await this.dispatch(
			{
				url: `${PROTON_API_BASE}/auth/v4/refresh`,
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					ResponseType: "token",
					GrantType: "refresh_token",
					RefreshToken: tokens.refreshToken,
					RedirectURI: "https://protonmail.ch",
				}),
			},
			tokens,
		);
		if (response.status === 429) failBackend("rate_limit", "Proton rate-limited the session refresh");
		if (response.status >= 400 && response.status < 500) return null;
		if (response.status !== 200) failBackend("transient", `Proton session refresh failed (${response.status})`);
		const data = await response.json();
		if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
		return parseSessionTokens({
			UID: data.UID ?? tokens.uid,
			AccessToken: data.AccessToken,
			RefreshToken: data.RefreshToken ?? tokens.refreshToken,
		});
	}
}
