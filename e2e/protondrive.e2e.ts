import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe } from "vitest";
import type { MovedObjectIdentity } from "../tests/fs/contracts/caching-remote-fs.contract";
import { runIFileSystemContract } from "../tests/fs/contracts/ifilesystem.contract";
import { ProtonDriveAdapter } from "../src/backends/protondrive/adapter";
import type { NodeUid, ProtonDriveApi } from "../src/backends/protondrive/drive-api";
import type { ClientUid } from "../src/backends/protondrive/sdk-client";
import { openProtonDrive } from "../src/backends/protondrive/sdk-client";
import { ManagedRemoteFs } from "../src/fs/managed/managed-remote-fs";
import { protonRuntimeContext, protonSecretsPath } from "./helpers/protondrive";
import { runPriorityFidelityE2E } from "./helpers/priority-fidelity";
import { runRenameSafetyE2E } from "./helpers/rename-safety";

const PROTON_MOVED_OBJECT_IDENTITY: MovedObjectIdentity = {
	determinate: true,
	reason:
		"projectNode sets RemoteObject.id to the SDK node uid for files and folders alike; " +
		"a Proton rename keeps the node (and its uid), so the moved object's identity is the pre-move uid.",
};

/**
 * Opt-in real-cloud e2e (ADR 0003) for Proton Drive: the shared contracts against
 * the live API through the real SDK. Skips without a session; create one with
 * `npm run e2e:bootstrap -- protondrive`. Runs under a fresh `airsync-e2e-*`
 * folder in My Files, trashed afterwards.
 */
if (!existsSync(protonSecretsPath())) {
	console.warn("[e2e] Skipping Proton Drive: run `npm run e2e:bootstrap -- protondrive` (see docs/e2e-testing.md).");
	describe.skip("IFileSystem contract — ManagedRemoteFs<protondrive> (real) [no session]", () => {
		/* skipped */
	});
} else {
	const context = protonRuntimeContext();
	let drive: ProtonDriveApi;
	let parent: NodeUid | undefined;

	beforeAll(async () => {
		drive = (await openProtonDrive(context, `air-sync-e2e-${crypto.randomUUID()}` as ClientUid)).drive;
		const myFiles = await drive.getMyFilesRoot();
		parent = (await drive.createFolder(myFiles.uid, `airsync-e2e-${Date.now()}`)).uid;
	});
	afterAll(async () => {
		if (!parent) return;
		try {
			await drive.trash(parent);
		} catch (err) {
			console.warn(`[e2e] Proton cleanup failed (trash airsync-e2e-* by hand): ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	async function makeChild(): Promise<NodeUid> {
		if (!parent) throw new Error("Proton e2e parent folder was not created");
		return (await drive.createFolder(parent, crypto.randomUUID())).uid;
	}

	function makeManagedFs(childUid: NodeUid, dbNamePrefix: string): ManagedRemoteFs {
		return new ManagedRemoteFs({
			adapter: new ProtonDriveAdapter(drive, childUid),
			name: "protondrive",
			rootFolderId: childUid,
			vaultId: crypto.randomUUID(),
			store: { dbNamePrefix, version: 1 },
		});
	}

	runIFileSystemContract(
		"ManagedRemoteFs<protondrive> (real)",
		async () => makeManagedFs(await makeChild(), "air-sync-protondrive-e2e-contract"),
		// The revision's claimed modification time is stored at whole-second precision.
		{ computesHashOnStat: false, mtimePrecisionMs: 1000, stableIdentity: true },
	);

	runPriorityFidelityE2E(
		"ManagedRemoteFs<protondrive>",
		async () => makeManagedFs(await makeChild(), "air-sync-protondrive-e2e-priority"),
	);

	runRenameSafetyE2E("ManagedRemoteFs<protondrive>", {
		backendType: "protondrive",
		movedObjectIdentity: PROTON_MOVED_OBJECT_IDENTITY,
		makeBackend: async () => {
			const fs = makeManagedFs(await makeChild(), "air-sync-protondrive-e2e-rename");
			return {
				fs,
				renameOutOfBand: async (file, newPath) => {
					await drive.rename(file.identityKey as NodeUid, newPath.split("/").pop() ?? newPath);
				},
			};
		},
	});
}
