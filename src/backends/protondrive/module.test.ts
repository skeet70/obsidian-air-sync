import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendRuntimeContext, BackendSecretStore } from "../../backend-api";
import type { DriveNode, NodeUid, ProtonDriveApi } from "./drive-api";
import { completeFork } from "./fork-login";
import { protonDriveModule } from "./module";
import { openProtonDrive, type ProtonConnection } from "./sdk-client";
import type { ProtonSession } from "./session";
import { SESSION_SECRET_KEY } from "./session";

vi.mock("./sdk-client", () => ({ openProtonDrive: vi.fn() }));
vi.mock("./fork-login", async (original) => ({ ...(await original<object>()), completeFork: vi.fn() }));

const MY_FILES = "vol~myfiles" as NodeUid;

/** My files and its folder tree, with `createFolder` recording what it made. */
class FolderTree {
	readonly nodes: DriveNode[] = [{ uid: MY_FILES, name: null, kind: "folder", trashed: false, degraded: false }];
	readonly created: string[] = [];

	add(uid: string, parent: NodeUid, name: string, kind: DriveNode["kind"] = "folder"): NodeUid {
		this.nodes.push({ uid: uid as NodeUid, parentUid: parent, name, kind, trashed: false, degraded: false });
		return uid as NodeUid;
	}

	drive(): ProtonDriveApi {
		const unreachable = (): never => {
			throw new Error("not used by binding");
		};
		return {
			getMyFilesRoot: () => Promise.resolve(this.nodes[0]!),
			listChildren: (parent) => Promise.resolve(this.nodes.filter((node) => node.parentUid === parent)),
			createFolder: (parent, name) => {
				this.created.push(name);
				const uid = this.add(`vol~new-${this.created.length}`, parent, name);
				return Promise.resolve(this.nodes.find((node) => node.uid === uid)!);
			},
			getNodes: unreachable,
			latestEventId: unreachable,
			readEvents: unreachable,
			downloadRevision: unreachable,
			createFile: unreachable,
			uploadRevision: unreachable,
			rename: unreachable,
			move: unreachable,
			trash: unreachable,
		};
	}
}

let tree: FolderTree;
const context = {} as BackendRuntimeContext;

beforeEach(() => {
	tree = new FolderTree();
	vi.mocked(openProtonDrive).mockResolvedValue({ drive: tree.drive() } as ProtonConnection);
});

describe("protondrive binding.resolveDefault", () => {
	it("binds an existing nested folder path without creating anything", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");
		const inner = tree.add("vol~inner", notes, "notes");

		const result = await protonDriveModule.binding.resolveDefault(context, { folderPath: "notes/notes" }, "Vault");

		expect(result.target).toEqual({ id: inner });
		expect(result.patch).toEqual({ set: { remoteVaultFolderId: inner } });
		expect(tree.created).toEqual([]);
	});

	it("creates only the missing trailing segment of a folder path", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");

		const result = await protonDriveModule.binding.resolveDefault(context, { folderPath: "notes/work" }, "Vault");

		expect(tree.created).toEqual(["work"]);
		expect(tree.nodes.find((node) => node.uid === result.target.id)).toMatchObject({ parentUid: notes, name: "work" });
	});

	it("rejects a folder path containing ..", async () => {
		tree.add("vol~notes", MY_FILES, "notes");

		await expect(
			protonDriveModule.binding.resolveDefault(context, { folderPath: "notes/../other" }, "Vault"),
		).rejects.toMatchObject({ kind: "permanent" });
		expect(tree.created).toEqual([]);
	});

	it("rejects a folder path through a file", async () => {
		tree.add("vol~file", MY_FILES, "notes", "file");

		await expect(
			protonDriveModule.binding.resolveDefault(context, { folderPath: "notes/notes" }, "Vault"),
		).rejects.toMatchObject({ kind: "permanent" });
	});

	it("with a blank folder path, binds the obsidian-air-sync/<vault> default", async () => {
		const result = await protonDriveModule.binding.resolveDefault(context, { folderPath: "  " }, "Vault");

		expect(tree.created).toEqual(["obsidian-air-sync", "Vault"]);
		expect(protonDriveModule.binding.appRoot?.defaultFolderPath("Vault")).toBe("obsidian-air-sync/Vault");
		expect(result.patch.set?.remoteVaultFolderId).toBe(result.target.id);
	});
});

describe("protondrive auth.complete", () => {
	const session = { uid: "UID", accessToken: "AT", refreshToken: "RT", keyPassword: "KP" } as unknown as ProtonSession;

	function signInContext(): { context: BackendRuntimeContext; secrets: Map<string, string>; logged: string[] } {
		const secrets = new Map<string, string>();
		const store: BackendSecretStore = {
			get: (key) => Promise.resolve(secrets.get(key) ?? null),
			set: (key, value) => Promise.resolve(void secrets.set(key, value)),
			delete: (key) => Promise.resolve(void secrets.delete(key)),
		};
		const logged: string[] = [];
		const log = (message: string) => void logged.push(message);
		const context = {
			http: { request: () => Promise.reject(new Error("no request expected")) },
			secrets: store,
			logger: { debug: log, info: log, warn: log, error: log },
			auth: { openExternal: () => Promise.resolve() },
		} as BackendRuntimeContext;
		return { context, secrets, logged };
	}

	beforeEach(() => {
		vi.mocked(completeFork).mockResolvedValue(session);
		vi.mocked(openProtonDrive).mockClear();
	});

	it("binds the configured folder and ends the pending sign-in", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");
		const inner = tree.add("vol~inner", notes, "notes");
		const { context, secrets } = signInContext();

		const patch = await protonDriveModule.auth.complete(context, "", { folderPath: "notes/notes", pendingAuthState: "1" });

		expect(patch.set?.remoteVaultFolderId).toBe(inner);
		expect(patch.unset).toContain("pendingAuthState");
		expect(secrets.has(SESSION_SECRET_KEY)).toBe(true);
		expect(tree.created).toEqual([]);
	});

	it("leaves the vault unbound without a configured folder", async () => {
		const { context } = signInContext();

		const patch = await protonDriveModule.auth.complete(context, "", { pendingAuthState: "1" });

		expect(patch.set).not.toHaveProperty("remoteVaultFolderId");
		expect(patch.unset).toContain("pendingAuthState");
		expect(openProtonDrive).not.toHaveBeenCalled();
	});

	it("keeps the session when the configured folder cannot be bound", async () => {
		tree.add("vol~file", MY_FILES, "notes", "file");
		const { context, secrets, logged } = signInContext();

		const patch = await protonDriveModule.auth.complete(context, "", { folderPath: "notes/notes", pendingAuthState: "1" });

		expect(patch.set).not.toHaveProperty("remoteVaultFolderId");
		expect(patch.unset).toContain("pendingAuthState");
		expect(secrets.has(SESSION_SECRET_KEY)).toBe(true);
		expect(logged.some((message) => message.includes("notes/notes"))).toBe(true);
	});
});

describe("protondrive disconnectConfig", () => {
	it("keeps only the configured folder", () => {
		expect(protonDriveModule.disconnectConfig?.({ folderPath: "notes/notes", clientUid: "c", remoteVaultFolderId: "f", pendingAuthState: "1" }))
			.toEqual({ folderPath: "notes/notes" });
	});
});

describe("protondrive binding.listAppRootFolders", () => {
	it("lists only the folders directly under My files", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");
		tree.add("vol~inner", notes, "inner");
		tree.add("vol~file", MY_FILES, "readme.md", "file");
		tree.add("vol~archive", MY_FILES, "archive");

		expect(await protonDriveModule.binding.listAppRootFolders!(context, {})).toEqual(["archive", "notes"]);
	});
});
