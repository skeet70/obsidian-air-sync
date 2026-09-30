import { describe, expect, it } from "vitest";
import { ProtonDriveAdapter } from "./adapter";
import type { DriveNode, NodeUid, ProtonDriveApi } from "./drive-api";

const ROOT = "vol~root" as NodeUid;
const OUTSIDE = "vol~outside" as NodeUid;
const VOLUME_ROOT = "vol~myfiles" as NodeUid;

function folder(uid: string, parentUid: NodeUid, name: string | null): DriveNode {
	return { uid: uid as NodeUid, parentUid, name, kind: "folder", trashed: false, degraded: false };
}

/** Only the reads `listAll`/`getChanges` make. */
function drive(nodes: readonly DriveNode[], touched: readonly NodeUid[] = []): ProtonDriveApi {
	const byUid = new Map(nodes.map((node) => [node.uid, node]));
	const unreachable = (): never => {
		throw new Error("not used by this test");
	};
	return {
		getMyFilesRoot: unreachable,
		getNodes: (uids) => Promise.resolve(new Map(uids.flatMap((uid) => (byUid.has(uid) ? [[uid, byUid.get(uid)!] as const] : [])))),
		listChildren: (parent) => Promise.resolve(nodes.filter((node) => node.parentUid === parent)),
		latestEventId: unreachable,
		readEvents: (_scope, since) => Promise.resolve({ kind: "events", touched, lastEventId: since }),
		downloadRevision: unreachable,
		createFile: unreachable,
		uploadRevision: unreachable,
		createFolder: unreachable,
		rename: unreachable,
		move: unreachable,
		trash: unreachable,
	};
}

const tree = [
	folder("vol~root", VOLUME_ROOT, "vault"),
	folder("vol~outside", VOLUME_ROOT, "elsewhere"),
	folder("vol~sub", ROOT, "sub"),
];

describe("ProtonDriveAdapter with an undecryptable name", () => {
	it("fails the listing when the node is inside the bound root", async () => {
		const adapter = new ProtonDriveAdapter(drive([...tree, folder("vol~bad", "vol~sub" as NodeUid, null)]), ROOT);
		await expect(adapter.listAll()).rejects.toMatchObject({ kind: "unverifiable" });
	});

	it("fails the delta when a touched node inside the bound root is unnamed", async () => {
		const bad = folder("vol~bad", "vol~sub" as NodeUid, null);
		const adapter = new ProtonDriveAdapter(drive([...tree, bad], [bad.uid]), ROOT);
		await expect(adapter.getChanges("event-1")).rejects.toMatchObject({ kind: "unverifiable" });
	});

	it("ignores an unnamed node outside the bound root", async () => {
		const bad = folder("vol~bad", OUTSIDE, null);
		const adapter = new ProtonDriveAdapter(drive([...tree, bad], [bad.uid]), ROOT);
		expect(await adapter.getChanges("event-1")).toEqual({ kind: "changes", nextCursor: "event-1", changes: [] });
	});
});
