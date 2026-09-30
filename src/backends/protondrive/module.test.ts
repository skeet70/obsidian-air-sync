import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendRuntimeContext } from "../../backend-api";
import type { DriveNode, NodeUid, ProtonDriveApi } from "./drive-api";
import { protonDriveModule } from "./module";
import { openProtonDrive, type ProtonConnection } from "./sdk-client";

vi.mock("./sdk-client", () => ({ openProtonDrive: vi.fn() }));

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
	it("binds an existing nested picked folder without creating anything", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");
		const inner = tree.add("vol~inner", notes, "notes");

		const result = await protonDriveModule.binding.resolveDefault(context, { pendingPickedFolderPath: "notes/notes" }, "Vault");

		expect(result.target).toEqual({ id: inner });
		expect(result.patch).toEqual({ set: { remoteVaultFolderId: inner, pendingPickedFolderPath: "" } });
		expect(tree.created).toEqual([]);
	});

	it("creates only the missing trailing segment of a picked path", async () => {
		const notes = tree.add("vol~notes", MY_FILES, "notes");

		const result = await protonDriveModule.binding.resolveDefault(context, { pendingPickedFolderPath: "notes/work" }, "Vault");

		expect(tree.created).toEqual(["work"]);
		expect(tree.nodes.find((node) => node.uid === result.target.id)).toMatchObject({ parentUid: notes, name: "work" });
	});

	it("rejects a picked path containing ..", async () => {
		tree.add("vol~notes", MY_FILES, "notes");

		await expect(
			protonDriveModule.binding.resolveDefault(context, { pendingPickedFolderPath: "notes/../other" }, "Vault"),
		).rejects.toMatchObject({ kind: "permanent" });
		expect(tree.created).toEqual([]);
	});

	it("rejects a picked path through a file", async () => {
		tree.add("vol~file", MY_FILES, "notes", "file");

		await expect(
			protonDriveModule.binding.resolveDefault(context, { pendingPickedFolderPath: "notes/notes" }, "Vault"),
		).rejects.toMatchObject({ kind: "permanent" });
	});

	it("without a pick, binds obsidian-air-sync/<vault>", async () => {
		const result = await protonDriveModule.binding.resolveDefault(context, {}, "Vault");

		expect(tree.created).toEqual(["obsidian-air-sync", "Vault"]);
		expect(protonDriveModule.binding.appRoot?.defaultFolderPath("Vault")).toBe("obsidian-air-sync/Vault");
		expect(result.patch.set?.remoteVaultFolderId).toBe(result.target.id);
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
