/**
 * Type boundary for `@protontech/crypto`, which ships untranspiled TypeScript that
 * does not compile under this repo's compiler options. `tsconfig.json` maps the
 * package specifiers the Proton Drive module and SDK use to this file; esbuild
 * (`tsconfig.bundle.json`) and Vitest resolve the real package. Only the members
 * Air Sync calls are declared.
 */

export interface PublicKeyReference {
	getFingerprint(): string;
	isPrivate(): boolean;
}

export interface PrivateKeyReference extends PublicKeyReference {
	isPrivateKeyV4(): boolean;
}

export interface SessionKey {
	data: Uint8Array<ArrayBuffer>;
	algorithm: string | null;
	aeadAlgorithm?: string | null;
}

export declare enum VERIFICATION_STATUS {
	NOT_SIGNED = 0,
	SIGNED_AND_VALID = 1,
	SIGNED_AND_INVALID = 2,
}

export interface CryptoApiInterface {
	importPrivateKey(options: { armoredKey: string; passphrase: string | null }): Promise<PrivateKeyReference>;
	importPublicKey(options: { armoredKey: string } | { binaryKey: Uint8Array<ArrayBuffer> }): Promise<PublicKeyReference>;
	exportPublicKey(options: { key: PublicKeyReference; format: "binary" }): Promise<Uint8Array<ArrayBuffer>>;
	decryptMessage(options: {
		armoredMessage: string;
		armoredSignature: string;
		decryptionKeys: PrivateKeyReference[];
		verificationKeys: PublicKeyReference[];
	}): Promise<{ data: string; verificationStatus: VERIFICATION_STATUS }>;
	clearKeyStore(): Promise<void>;
}

export declare const CryptoProxy: CryptoApiInterface & {
	setEndpoint<T extends CryptoApiInterface>(endpoint: T, onRelease?: (endpoint: T) => Promise<void>): void;
};

/** `@protontech/crypto/proxy/endpoint/api.ts`: the in-thread endpoint. */
export declare const Api: {
	new (): CryptoApiInterface;
	init(options: Readonly<Record<string, never>>): void;
};

/** `@protontech/crypto/srp` */
export declare function getSrp(
	info: { Version: number; Modulus: string; ServerEphemeral: string; Salt: string },
	credentials: { password: string },
): Promise<{ clientEphemeral: string; clientProof: string; expectedServerProof: string }>;
export declare function getRandomSrpVerifier(
	info: { Modulus: string },
	credentials: { password: string },
): Promise<{ version: number; salt: string; verifier: string }>;
export declare function computeKeyPassword(password: string, salt: string): Promise<string>;
export declare function generateKeySalt(): string;
