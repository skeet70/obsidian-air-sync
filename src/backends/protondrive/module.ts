import type {
	BackendAuth,
	BackendBinding,
	BackendModule,
	BindingResult,
	JsonObject,
	RemoteBackendAdapter,
} from "../../backend-api";
import { BACKEND_MODULE_API_VERSION, REMOTE_VAULT_ROOT, sleep } from "../../backend-api";
import { failBackend } from "../shared/error-shape";
import { asString, resolveFolderTarget } from "../shared/module-utils";
import { ProtonDriveAdapter } from "./adapter";
import { PROTON_MODULE_VERSION } from "./constants";
import type { DriveNode, NodeUid } from "./drive-api";
import { findOrCreateFolderPath, listMyFilesFolders, parseFolderPath } from "./folder-path";
import { beginFork, completeFork } from "./fork-login";
import type { ClientUid } from "./sdk-client";
import { openProtonDrive } from "./sdk-client";
import { SESSION_SECRET_KEY, SessionHandle, saveSession } from "./session";
import { ProtonTransport } from "./transport";

function clientUidOf(config: Readonly<JsonObject>): ClientUid {
	return (asString(config.clientUid) || `air-sync-${crypto.randomUUID()}`) as ClientUid;
}

const auth: BackendAuth = {
	credentialKeys: [SESSION_SECRET_KEY],
	completion: "poll",
	start: async (context) => {
		const signInUrl = await beginFork(new ProtonTransport(context.http, null), context.secrets, Date.now());
		await context.auth.openExternal(signInUrl);
		return {};
	},
	complete: async (context, _input, config) => {
		const session = await completeFork(new ProtonTransport(context.http, null), context.secrets, {
			now: () => Date.now(),
			sleep,
		});
		await saveSession(context.secrets, session);
		return { set: { clientUid: clientUidOf(config) } };
	},
	revoke: async (context) => {
		const session = await SessionHandle.open(context.secrets).catch(() => null);
		if (!session) return;
		await new ProtonTransport(context.http, session).json("DELETE", "auth/v4");
	},
};

const binding: BackendBinding = {
	resolveDefault: async (context, config, vaultName): Promise<BindingResult> => {
		const existing = asString(config.remoteVaultFolderId);
		if (existing) return { patch: {}, target: { id: existing } };
		const picked = asString(config.pendingPickedFolderPath).trim();
		const name = vaultName.trim();
		if (!picked && !name) failBackend("permanent", "Cannot resolve the Proton Drive remote vault: the vault name is empty.");
		const path = parseFolderPath(picked || `${REMOTE_VAULT_ROOT}/${name}`);
		const { drive } = await openProtonDrive(context, clientUidOf(config));
		const vault = await findOrCreateFolderPath(drive, path);
		return {
			patch: { set: { remoteVaultFolderId: vault.uid, pendingPickedFolderPath: "" } },
			target: { id: vault.uid },
		};
	},
	listAppRootFolders: async (context, config) =>
		listMyFilesFolders((await openProtonDrive(context, clientUidOf(config))).drive),
	appRoot: {
		name: "My files",
		defaultFolderPath: (vaultName) => `${REMOTE_VAULT_ROOT}/${vaultName}`,
	},
	getDisplayPath: async (context, config, target) => {
		const { drive } = await openProtonDrive(context, clientUidOf(config));
		const names: string[] = [];
		let uid: NodeUid | undefined = target.id as NodeUid;
		while (uid !== undefined) {
			const node: DriveNode | undefined = (await drive.getNodes([uid])).get(uid);
			if (!node) return null;
			// The volume root's own name is not part of the path Proton shows.
			if (node.parentUid !== undefined) names.unshift(node.name ?? "?");
			uid = node.parentUid;
		}
		return { id: target.id, displayPath: `/${names.join("/")}` };
	},
};

/** Proton Drive over the official Proton Drive SDK. Unofficial: not affiliated with Proton AG. */
export const protonDriveModule: BackendModule = {
	id: "protondrive",
	displayName: "Proton Drive",
	version: PROTON_MODULE_VERSION,
	apiVersion: BACKEND_MODULE_API_VERSION,
	auth,
	binding,
	getTarget: resolveFolderTarget,
	disconnectConfig: () => ({}),
	createAdapter: async (context, config, target): Promise<RemoteBackendAdapter> =>
		new ProtonDriveAdapter((await openProtonDrive(context, clientUidOf(config))).drive, target.id as NodeUid),
};
