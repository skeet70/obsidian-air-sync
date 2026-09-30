// Built-ins the SDK and its crypto package call that older Android WebViews lack.
import "core-js/proposals/array-buffer-base64";
import "core-js/actual/array/from-async";
import "core-js/actual/iterator";
import "core-js/actual/promise/with-resolvers";
import { CryptoProxy } from "@protontech/crypto";
import { Api as CryptoApi } from "@protontech/crypto/proxy/endpoint/api.ts";
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from "@protontech/crypto/srp";
import type { ProtonDriveTelemetry } from "@protontech/drive-sdk";
import { MemoryCache, NullCache, OpenPGPCryptoWithCryptoProxy, ProtonDriveClient } from "@protontech/drive-sdk";
import type { BackendLogger, BackendRuntimeContext } from "../../backend-api";
import { errorMessage } from "../../backend-api";
import { failBackend } from "../shared/error-shape";
import { ProtonAccount } from "./account";
import { PROTON_API_HOST } from "./constants";
import type { ProtonDriveApi } from "./drive-api";
import { SdkDriveApi } from "./sdk-drive-api";
import { SessionHandle } from "./session";
import { ProtonTransport } from "./transport";

declare const clientUidBrand: unique symbol;
/** Stable per-install id the SDK stamps on upload drafts. */
export type ClientUid = string & { readonly [clientUidBrand]: true };

type SRPModule = ConstructorParameters<typeof ProtonDriveClient>[0]["srpModule"];

/** `CryptoProxy` is a process-wide singleton that throws if its endpoint is set twice. */
let cryptoEndpointSet = false;

function ensureCryptoEndpoint(): void {
	if (cryptoEndpointSet) return;
	CryptoApi.init({});
	CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
	cryptoEndpointSet = true;
}

function srpModule(transport: ProtonTransport): SRPModule {
	return {
		getSrp: (version, modulus, serverEphemeral, salt, password) =>
			getSrp({ Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt }, { password }),
		getSrpVerifier: async (password) => {
			const response = await transport.json("GET", "core/v4/auth/modulus");
			if (typeof response.Modulus !== "string" || typeof response.ModulusID !== "string") {
				failBackend("transient", "Proton did not return an SRP modulus");
			}
			const verifier = await getRandomSrpVerifier({ Modulus: response.Modulus }, { password });
			return { modulusId: response.ModulusID, ...verifier };
		},
		computeKeyPassword,
		generateKeySalt,
	};
}

/** SDK logs go to the module logger at one level lower; metrics are not collected. */
function telemetry(logger: BackendLogger): ProtonDriveTelemetry {
	return {
		getLogger: (name) => ({
			debug: (message) => logger.debug(`[sdk:${name}] ${message}`),
			info: (message) => logger.debug(`[sdk:${name}] ${message}`),
			warn: (message) => logger.info(`[sdk:${name}] ${message}`),
			error: (message, error) =>
				logger.warn(`[sdk:${name}] ${message}`, error === undefined ? undefined : { error: errorMessage(error) }),
		}),
		recordMetric: () => undefined,
	};
}

export interface ProtonConnection {
	readonly drive: ProtonDriveApi;
	readonly transport: ProtonTransport;
}

/**
 * The entity cache is a `NullCache` so every node read is current; the crypto
 * cache holds only decrypted keys, which do not change for a node.
 */
export async function openProtonDrive(context: BackendRuntimeContext, clientUid: ClientUid): Promise<ProtonConnection> {
	const session = await SessionHandle.open(context.secrets);
	const transport = new ProtonTransport(context.http, session);
	ensureCryptoEndpoint();
	const client = new ProtonDriveClient({
		httpClient: {
			fetchJson: (request) => transport.fetch(request),
			fetchBlob: (request) => transport.fetch(request),
		},
		entitiesCache: new NullCache(),
		cryptoCache: new MemoryCache(),
		account: new ProtonAccount(transport, CryptoProxy, session.current.keyPassword),
		openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
		srpModule: srpModule(transport),
		config: { baseUrl: PROTON_API_HOST, clientUid },
		telemetry: telemetry(context.logger),
	});
	return { drive: new SdkDriveApi(client), transport };
}
