/*!
 * Portions adapted from Proton's proton-drive-sdk-account
 * (incubating/account/js/src/addresses.ts, https://github.com/ProtonDriveApps/sdk).
 *
 * The MIT License
 *
 * Copyright (c) 2025-2026 Proton AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import type { CryptoApiInterface, PrivateKeyReference, PublicKeyReference } from "@protontech/crypto";
import { VERIFICATION_STATUS } from "@protontech/crypto/constants";
import type { ProtonDriveAccount, ProtonDriveAccountAddress } from "@protontech/drive-sdk";
import type { JsonValue } from "../../backend-api";
import type { KeyPassword } from "./session";
import type { ProtonTransport } from "./transport";
import { ProtonApiError } from "./transport";

/** Core API codes for "no such address" / "address is external" on `core/v4/keys/all`. */
const ADDRESS_NOT_FOUND_CODES: ReadonlySet<number> = new Set([33_102, 33_103]);

interface AddressKeyDto {
	readonly id: string;
	readonly privateKey: string;
	readonly token?: string;
	readonly signature?: string;
}

interface AddressDto {
	readonly id: string;
	readonly email: string;
	readonly keys: readonly AddressKeyDto[];
}

interface UserKeys {
	readonly privateKeys: PrivateKeyReference[];
	readonly publicKeys: PublicKeyReference[];
}

function records(value: JsonValue | undefined): Readonly<Record<string, JsonValue>>[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is Readonly<Record<string, JsonValue>> =>
		typeof item === "object" && item !== null && !Array.isArray(item));
}

function str(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function parseAddress(raw: Readonly<Record<string, JsonValue>>): AddressDto | null {
	const id = str(raw.ID);
	const email = str(raw.Email);
	if (!id || !email) return null;
	const keys: AddressKeyDto[] = [];
	for (const key of records(raw.Keys)) {
		const keyId = str(key.ID);
		const privateKey = str(key.PrivateKey);
		if (keyId && privateKey) keys.push({ id: keyId, privateKey, token: str(key.Token), signature: str(key.Signature) });
	}
	return { id, email, keys };
}

/**
 * The account half the SDK needs: the user's own address keys and other users'
 * public keys. Loaded once per connection.
 */
export class ProtonAccount implements ProtonDriveAccount {
	private addressesPromise?: Promise<readonly AddressDto[]>;
	private userKeysPromise?: Promise<UserKeys>;
	private readonly addressKeys = new Map<string, Promise<{ id: string; key: PrivateKeyReference }>>();
	private readonly otherPublicKeys = new Map<string, Promise<PublicKeyReference[]>>();

	constructor(
		private readonly transport: ProtonTransport,
		private readonly crypto: CryptoApiInterface,
		private readonly keyPassword: KeyPassword,
	) {}

	async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
		const [primary] = await this.addresses();
		if (!primary) throw new Error("Proton account has no address");
		return this.decryptAddress(primary);
	}

	async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
		const addresses = await this.addresses();
		return Promise.all(addresses.map((address) => this.decryptAddress(address)));
	}

	async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
		const address = (await this.addresses()).find((a) => a.id === emailOrAddressId || a.email === emailOrAddressId);
		if (!address) throw new Error(`Proton address ${emailOrAddressId} not found`);
		return this.decryptAddress(address);
	}

	async hasProtonAccount(email: string): Promise<boolean> {
		return (await this.getPublicKeys(email)).length > 0;
	}

	async getPublicKeys(email: string, forceRefresh?: boolean): Promise<PublicKeyReference[]> {
		const own = (await this.addresses()).find((a) => a.email === email);
		if (own) {
			const decrypted = await this.decryptAddress(own);
			return Promise.all(decrypted.keys.map(({ key }) => this.publicOf(key)));
		}
		const cached = this.otherPublicKeys.get(email);
		if (cached && !forceRefresh) return cached;
		const loading = this.loadOtherPublicKeys(email);
		this.otherPublicKeys.set(email, loading);
		loading.catch(() => this.otherPublicKeys.delete(email));
		return loading;
	}

	private addresses(): Promise<readonly AddressDto[]> {
		this.addressesPromise ??= this.transport.json("GET", "core/v4/addresses?Page=0&PageSize=50").then((response) => {
			const parsed = records(response.Addresses).map(parseAddress).filter((a): a is AddressDto => a !== null);
			if (parsed.length === 0) throw new Error("Proton account has no address");
			return parsed;
		});
		this.addressesPromise.catch(() => {
			this.addressesPromise = undefined;
		});
		return this.addressesPromise;
	}

	private userKeys(): Promise<UserKeys> {
		this.userKeysPromise ??= this.loadUserKeys();
		this.userKeysPromise.catch(() => {
			this.userKeysPromise = undefined;
		});
		return this.userKeysPromise;
	}

	private async loadUserKeys(): Promise<UserKeys> {
		const response = await this.transport.json("GET", "core/v4/users");
		const user = response.User;
		const rawKeys = typeof user === "object" && user !== null && !Array.isArray(user) ? records(user.Keys) : [];
		const privateKeys: PrivateKeyReference[] = [];
		const publicKeys: PublicKeyReference[] = [];
		for (const raw of rawKeys) {
			const armoredKey = str(raw.PrivateKey);
			if (!armoredKey) continue;
			const privateKey = await this.crypto.importPrivateKey({ armoredKey, passphrase: this.keyPassword }).catch(() => null);
			if (!privateKey) continue;
			privateKeys.push(privateKey);
			publicKeys.push(await this.publicOf(privateKey));
		}
		if (privateKeys.length === 0) throw new Error("No Proton user key could be decrypted");
		return { privateKeys, publicKeys };
	}

	private async decryptAddress(address: AddressDto): Promise<ProtonDriveAccountAddress> {
		const settled = await Promise.allSettled(address.keys.map((key) => this.addressKey(key)));
		const keys = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		if (keys.length === 0) throw new Error(`No key of Proton address ${address.email} could be decrypted`);
		return { email: address.email, addressId: address.id, primaryKeyIndex: 0, keys };
	}

	private addressKey(key: AddressKeyDto): Promise<{ id: string; key: PrivateKeyReference }> {
		let loading = this.addressKeys.get(key.id);
		if (!loading) {
			loading = this.decryptAddressKey(key);
			this.addressKeys.set(key.id, loading);
			loading.catch(() => this.addressKeys.delete(key.id));
		}
		return loading;
	}

	/** Legacy address keys use the key password directly; current ones a token signed by the user key. */
	private async decryptAddressKey(key: AddressKeyDto): Promise<{ id: string; key: PrivateKeyReference }> {
		if (!key.token) {
			return { id: key.id, key: await this.crypto.importPrivateKey({ armoredKey: key.privateKey, passphrase: this.keyPassword }) };
		}
		const { privateKeys, publicKeys } = await this.userKeys();
		const { data, verificationStatus } = await this.crypto.decryptMessage({
			armoredMessage: key.token,
			armoredSignature: key.signature ?? "",
			decryptionKeys: privateKeys,
			verificationKeys: publicKeys,
		});
		if (verificationStatus !== VERIFICATION_STATUS.SIGNED_AND_VALID) {
			throw new Error(`Proton address key ${key.id} token signature is not valid`);
		}
		return { id: key.id, key: await this.crypto.importPrivateKey({ armoredKey: key.privateKey, passphrase: data }) };
	}

	private async publicOf(key: PrivateKeyReference): Promise<PublicKeyReference> {
		return this.crypto.importPublicKey({ binaryKey: await this.crypto.exportPublicKey({ key, format: "binary" }) });
	}

	private async loadOtherPublicKeys(email: string): Promise<PublicKeyReference[]> {
		let response;
		try {
			response = await this.transport.json("GET", `core/v4/keys/all?Email=${encodeURIComponent(email)}&InternalOnly=1`);
		} catch (err) {
			if (err instanceof ProtonApiError && err.code !== undefined && ADDRESS_NOT_FOUND_CODES.has(err.code)) return [];
			throw err;
		}
		const address = response.Address;
		const keys = typeof address === "object" && address !== null && !Array.isArray(address) ? records(address.Keys) : [];
		const armored = keys.map((key) => str(key.PublicKey)).filter((value): value is string => value !== undefined);
		return Promise.all(armored.map((armoredKey) => this.crypto.importPublicKey({ armoredKey })));
	}
}
