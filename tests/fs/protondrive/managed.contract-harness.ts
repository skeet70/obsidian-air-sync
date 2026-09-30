import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { BackendErrorKind, DestinationAddress, RemoteBackendCapabilities, RemoteObject } from "../../../src/backend-api";
import { backendError } from "../../../src/backend-api";
import { toBackendError } from "../../../src/backends/shared/error-shape";
import { ProtonDriveAdapter } from "../../../src/backends/protondrive/adapter";
import type {
	DriveDownload,
	DriveEventRead,
	DriveNode,
	DriveNodeKind,
	DriveUploadMetadata,
	EventId,
	NodeUid,
	ProtonDriveApi,
	RevisionUid,
	TreeScopeId,
} from "../../../src/backends/protondrive/drive-api";
import { ManagedRemoteFs } from "../../../src/fs/managed/managed-remote-fs";
import { MetadataStore } from "../../../src/store/metadata-store";
import { sha1 } from "../../../src/utils/hash";
import { runIFileSystemContract } from "../contracts/ifilesystem.contract";
import { runRemoteFamilyCachingContract } from "../contracts/caching-remote-fs.contract";
import type { RemoteFamilyCachingHarness } from "../contracts/caching-remote-fs.contract";
import { bytes, statOrThrow, runRemoteChangeDetectionContract } from "../contracts/remote-change-detection.contract";
import { runBackendConcurrencyContract } from "../contracts/backend-concurrency.contract";
import type { BackendConcurrencyHarness } from "../contracts/backend-concurrency.contract";
import {
	runPriorityObservationContract,
	type PriorityObservationContractHarness,
	type PriorityObservationScenario,
} from "../contracts/priority-observation.contract";

vi.mock("obsidian");

const VOLUME = "vol";
const nodeUid = (linkId: string): NodeUid => `${VOLUME}~${linkId}` as NodeUid;
const MY_FILES = nodeUid("myfiles");
const ROOT = nodeUid("root");
const OUTSIDE = nodeUid("outside");
const STORE = { dbNamePrefix: "air-sync-protondrive-managed-contract", version: 1 };
const MODIFIED_MS = Date.UTC(2024, 0, 1);

function fail(kind: BackendErrorKind, message: string): never {
	throw toBackendError(backendError(kind, message));
}

interface RevisionRecord {
	readonly uid: RevisionUid;
	readonly content: ArrayBuffer;
	readonly size: number;
	readonly mtimeMs: number;
	/** Empty until the pending digest of a staged revision settles. */
	sha1: string;
}

interface NodeRecord {
	readonly uid: NodeUid;
	parentUid?: NodeUid;
	name: string | null;
	readonly kind: DriveNodeKind;
	mediaType?: string;
	trashed: boolean;
	degraded: boolean;
	/** Oldest first; the last one is active. */
	readonly revisions: RevisionRecord[];
}

/**
 * One in-memory Proton Drive volume. Every revision is kept; event ids are offsets
 * into the log of touched uids. Staged revisions are recorded synchronously and their
 * SHA-1 is filled in before the next API call returns.
 */
class FakeProtonDrive implements ProtonDriveApi {
	private readonly nodes = new Map<NodeUid, NodeRecord>();
	private readonly events: NodeUid[] = [];
	private readonly outside = new Map<string, NodeUid>();
	private linkSeq = 0;
	private revisionSeq = 0;
	private digests: Promise<void> = Promise.resolve();
	private failNextEventRead = false;
	private expireNextEventRead = false;
	private afterObservation?: (uid: NodeUid) => void;

	constructor() {
		this.nodes.set(MY_FILES, { uid: MY_FILES, name: "My files", kind: "folder", trashed: false, degraded: false, revisions: [] });
		this.nodes.set(ROOT, { uid: ROOT, parentUid: MY_FILES, name: "vault", kind: "folder", trashed: false, degraded: false, revisions: [] });
		this.nodes.set(OUTSIDE, { uid: OUTSIDE, parentUid: MY_FILES, name: "elsewhere", kind: "folder", trashed: false, degraded: false, revisions: [] });
	}

	// ── Model ──

	private isTrashed(record: NodeRecord): boolean {
		for (let cur: NodeRecord | undefined = record; cur; cur = cur.parentUid ? this.nodes.get(cur.parentUid) : undefined) {
			if (cur.trashed) return true;
		}
		return false;
	}

	private snapshot(record: NodeRecord): DriveNode {
		const active = record.revisions.at(-1);
		return {
			uid: record.uid,
			parentUid: record.parentUid,
			name: record.name,
			kind: record.kind,
			mediaType: record.mediaType,
			trashed: this.isTrashed(record),
			degraded: record.degraded,
			revision: active && { uid: active.uid, size: active.size, mtimeMs: active.mtimeMs, sha1: active.sha1 },
		};
	}

	private live(uid: NodeUid): NodeRecord {
		const record = this.nodes.get(uid);
		if (!record || this.isTrashed(record)) fail("not_found", `Proton Drive node ${uid} was not found`);
		return record;
	}

	private liveFolder(uid: NodeUid): NodeRecord {
		const record = this.live(uid);
		if (record.kind !== "folder") fail("not_found", `Proton Drive node ${uid} is not a folder`);
		return record;
	}

	private children(parent: NodeUid): NodeRecord[] {
		return [...this.nodes.values()].filter((record) => record.parentUid === parent && !record.trashed);
	}

	private assertNameFree(parent: NodeUid, name: string, except?: NodeUid): void {
		if (this.children(parent).some((child) => child.name === name && child.uid !== except)) {
			fail("target_changed", `"${name}" already exists in Proton Drive folder ${parent}`);
		}
	}

	/** Without `metadata`, the revision claims the SHA-1 of `content` once its digest settles. */
	private revision(file: NodeUid, content: ArrayBuffer, mtimeMs: number, metadata?: DriveUploadMetadata): RevisionRecord {
		const revision: RevisionRecord = {
			uid: `${file}~r${++this.revisionSeq}` as RevisionUid,
			content: content.slice(0),
			size: content.byteLength,
			mtimeMs: metadata?.mtimeMs ?? mtimeMs,
			sha1: metadata?.sha1 ?? "",
		};
		if (!metadata) {
			this.digests = this.digests.then(async () => {
				revision.sha1 = await sha1(revision.content);
			});
		}
		return revision;
	}

	private insertFile(parent: NodeUid, name: string, content: ArrayBuffer, mtimeMs: number, metadata?: DriveUploadMetadata): NodeUid {
		this.liveFolder(parent);
		this.assertNameFree(parent, name);
		const uid = nodeUid(`f${++this.linkSeq}`);
		this.nodes.set(uid, {
			uid,
			parentUid: parent,
			name,
			kind: "file",
			mediaType: metadata?.mediaType ?? "text/plain",
			trashed: false,
			degraded: false,
			revisions: [this.revision(uid, content, mtimeMs, metadata)],
		});
		this.events.push(uid);
		return uid;
	}

	private insertFolder(parent: NodeUid, name: string): NodeRecord {
		this.liveFolder(parent);
		this.assertNameFree(parent, name);
		const uid = nodeUid(`d${++this.linkSeq}`);
		const record: NodeRecord = { uid, parentUid: parent, name, kind: "folder", trashed: false, degraded: false, revisions: [] };
		this.nodes.set(uid, record);
		this.events.push(uid);
		return record;
	}

	private appendRevision(uid: NodeUid, content: ArrayBuffer, mtimeMs: number, metadata?: DriveUploadMetadata): void {
		const record = this.live(uid);
		if (record.kind !== "file") fail("permanent", `Proton Drive node ${uid} is not a file`);
		if (metadata) record.mediaType = metadata.mediaType;
		record.revisions.push(this.revision(uid, content, mtimeMs, metadata));
		this.events.push(uid);
	}

	private renameNode(uid: NodeUid, name: string): void {
		const record = this.live(uid);
		if (record.parentUid) this.assertNameFree(record.parentUid, name, uid);
		record.name = name;
		this.events.push(uid);
	}

	private moveNode(uid: NodeUid, parent: NodeUid): void {
		const record = this.live(uid);
		this.liveFolder(parent);
		if (record.name !== null) this.assertNameFree(parent, record.name, uid);
		record.parentUid = parent;
		this.events.push(uid);
	}

	private trashNode(uid: NodeUid): void {
		this.live(uid).trashed = true;
		this.events.push(uid);
	}

	private resolveOrThrow(path: string, operation: string, kind?: DriveNodeKind): NodeRecord {
		let record = this.nodes.get(ROOT);
		for (const segment of path.split("/")) {
			record = record && this.children(record.uid).find((child) => child.name === segment);
		}
		if (!record || (kind && record.kind !== kind)) throw new Error(`${operation}: no such path "${path}"`);
		return record;
	}

	private parentOf(path: string, operation: string): { parent: NodeUid; name: string } {
		const slash = path.lastIndexOf("/");
		const parent = slash < 0 ? ROOT : this.resolveOrThrow(path.slice(0, slash), operation, "folder").uid;
		return { parent, name: path.slice(slash + 1) };
	}

	// ── ProtonDriveApi ──

	async getMyFilesRoot(): Promise<DriveNode> {
		await this.digests;
		return this.snapshot(this.nodes.get(MY_FILES)!);
	}

	async getNodes(uids: readonly NodeUid[]): Promise<ReadonlyMap<NodeUid, DriveNode>> {
		await this.digests;
		const found = new Map<NodeUid, DriveNode>();
		for (const uid of uids) {
			const record = this.nodes.get(uid);
			if (record) found.set(uid, this.snapshot(record));
		}
		// A staged concurrent change lands after the snapshot was taken.
		const hook = this.afterObservation;
		if (hook) for (const uid of found.keys()) hook(uid);
		return found;
	}

	async listChildren(folder: NodeUid): Promise<readonly DriveNode[]> {
		await this.digests;
		this.liveFolder(folder);
		return this.children(folder).map((child) => this.snapshot(child));
	}

	async latestEventId(scope: TreeScopeId): Promise<EventId> {
		if (scope !== VOLUME) fail("not_found", `Unknown Proton Drive volume ${scope}`);
		await this.digests;
		return String(this.events.length) as EventId;
	}

	async readEvents(scope: TreeScopeId, since: EventId): Promise<DriveEventRead> {
		await this.digests;
		if (this.failNextEventRead) {
			this.failNextEventRead = false;
			fail("transient", "injected later page failure");
		}
		if (this.expireNextEventRead) {
			this.expireNextEventRead = false;
			return { kind: "refresh" };
		}
		const offset = Number(since);
		if (scope !== VOLUME || !/^\d+$/.test(since) || offset > this.events.length) return { kind: "refresh" };
		return {
			kind: "events",
			touched: [...new Set(this.events.slice(offset))],
			lastEventId: String(this.events.length) as EventId,
		};
	}

	async downloadRevision(revision: RevisionUid): Promise<DriveDownload> {
		await this.digests;
		for (const record of this.nodes.values()) {
			const match = record.revisions.find((candidate) => candidate.uid === revision);
			if (match) return { kind: "content", bytes: match.content.slice(0) };
		}
		fail("not_found", `Proton Drive revision ${revision} was not found`);
	}

	async createFile(parent: NodeUid, name: string, content: ArrayBuffer, metadata: DriveUploadMetadata): Promise<NodeUid> {
		await this.digests;
		return this.insertFile(parent, name, content, metadata.mtimeMs, metadata);
	}

	async uploadRevision(file: NodeUid, content: ArrayBuffer, metadata: DriveUploadMetadata): Promise<void> {
		await this.digests;
		this.appendRevision(file, content, metadata.mtimeMs, metadata);
	}

	async createFolder(parent: NodeUid, name: string): Promise<DriveNode> {
		await this.digests;
		return this.snapshot(this.insertFolder(parent, name));
	}

	async rename(node: NodeUid, name: string): Promise<void> {
		await this.digests;
		this.renameNode(node, name);
	}

	async move(node: NodeUid, parent: NodeUid): Promise<void> {
		await this.digests;
		this.moveNode(node, parent);
	}

	async trash(node: NodeUid): Promise<void> {
		await this.digests;
		this.trashNode(node);
	}

	// ── Staging ──

	seedFile(path: string, content = bytes(""), mtimeMs = MODIFIED_MS): NodeUid {
		const { parent, name } = this.parentOf(path, "seedFile");
		return this.insertFile(parent, name, content, mtimeMs);
	}

	seedFolderWithChild(folderPath: string, childName: string): void {
		const folder = this.insertFolder(ROOT, folderPath);
		this.insertFile(folder.uid, childName, bytes(""), MODIFIED_MS);
	}

	seedFolderOutsideRoot(folderPath: string): void {
		const folder = this.insertFolder(OUTSIDE, folderPath);
		this.insertFile(folder.uid, "a.md", bytes("a"), MODIFIED_MS);
		const sub = this.insertFolder(folder.uid, "sub");
		this.insertFile(sub.uid, "b.md", bytes("b"), MODIFIED_MS);
		this.outside.set(folderPath, folder.uid);
	}

	/** Proton records one event for the moved folder and none for its descendants. */
	stageMoveIntoRoot(folderPath: string): void {
		const uid = this.outside.get(folderPath);
		if (!uid) throw new Error(`stageMoveIntoRoot: no folder outside root at "${folderPath}"`);
		this.outside.delete(folderPath);
		this.moveNode(uid, ROOT);
	}

	stageRemoteDelete(path: string): void {
		this.trashNode(this.resolveOrThrow(path, "stageRemoteDelete").uid);
	}

	stageRemoteRename(oldPath: string, newPath: string, opts?: { isFolder?: boolean }): void {
		const record = this.resolveOrThrow(oldPath, "stageRemoteRename", opts?.isFolder ? "folder" : undefined);
		const { parent, name } = this.parentOf(newPath, "stageRemoteRename");
		if (record.name !== name) this.renameNode(record.uid, name);
		if (record.parentUid !== parent) this.moveNode(record.uid, parent);
	}

	stageRemoteRecreateWithNewId(path: string): NodeUid {
		this.stageRemoteDelete(path);
		return this.seedFile(path, bytes("replacement"));
	}

	failNextEventReadOnce(): void {
		this.failNextEventRead = true;
	}

	expireNextEventReadOnce(): void {
		this.expireNextEventRead = true;
	}

	// ── Concurrent changes and introspection ──

	concurrentWrite(uid: NodeUid, content: string): void {
		this.appendRevision(uid, bytes(content), Date.now());
	}

	/** Leaves the active revision in place. */
	touchMetadata(uid: NodeUid): void {
		this.live(uid);
		this.events.push(uid);
	}

	/** The SDK reported decryption errors for the node. */
	markDegraded(uid: NodeUid): void {
		this.live(uid).degraded = true;
	}

	afterNextObservation(target: NodeUid, action: () => void): void {
		this.afterObservation = (observed) => {
			if (observed !== target) return;
			this.afterObservation = undefined;
			action();
		};
	}

	contentOf(uid: NodeUid): string | null {
		const record = this.nodes.get(uid);
		const active = record && !this.isTrashed(record) ? record.revisions.at(-1) : undefined;
		return active ? new TextDecoder().decode(active.content) : null;
	}

	nameOf(uid: NodeUid): string | null {
		return this.nodes.get(uid)?.name ?? null;
	}

	activeRevision(uid: NodeUid): RevisionUid | undefined {
		return this.nodes.get(uid)?.revisions.at(-1)?.uid;
	}
}

function makeFs(
	fake: FakeProtonDrive,
	vaultId: string,
	metadataStore: MetadataStore<RemoteObject> = new MetadataStore<RemoteObject>(vaultId, STORE),
): ManagedRemoteFs {
	return new ManagedRemoteFs({
		adapter: new ProtonDriveAdapter(fake, ROOT),
		name: "protondrive",
		rootFolderId: ROOT,
		vaultId,
		store: STORE,
		metadataStore,
	});
}

function makeCachingHarness(): RemoteFamilyCachingHarness<RemoteObject> {
	const drive = new FakeProtonDrive();
	return {
		makeStore: (id) => new MetadataStore<RemoteObject>(id, STORE),
		makeFs: (store) => makeFs(drive, "managed", store),
		seedFile: (path) => void drive.seedFile(path),
		seedFolderWithChild: (folderPath, childName) => drive.seedFolderWithChild(folderPath, childName),
		seedFolderOutsideRoot: (folderPath) => drive.seedFolderOutsideRoot(folderPath),
		stageMoveIntoRoot: (folderPath) => drive.stageMoveIntoRoot(folderPath),
		stageRemoteDelete: (path) => drive.stageRemoteDelete(path),
		stageRemoteRename: (oldPath, newPath, opts) => drive.stageRemoteRename(oldPath, newPath, opts),
		stageRemoteRecreateWithNewId: (path) => void drive.stageRemoteRecreateWithNewId(path),
		failNextDeltaAfterFirstPage: () => drive.failNextEventReadOnce(),
		collision: {
			kind: "cannot",
			reason: "Proton Drive refuses a second node with the same name in one folder",
			unknown: "unknown-protondrive-duplicate-names",
		},
		movedObjectIdentity: {
			determinate: true,
			reason: "projectNode sets id from the SDK node uid for files and folders alike.",
		},
		renameOrderings: {
			encoding: "single-entry",
			reason: "Proton Drive events name the touched node uid once; the adapter re-reads its current state.",
		},
	};
}

export function registerProtonDriveManagedIFileSystemContract(): void {
	runIFileSystemContract(
		"ManagedRemoteFs<protondrive>",
		() => makeFs(new FakeProtonDrive(), "managed-fs"),
		{ computesHashOnStat: false, stableIdentity: true },
	);
}

export function registerProtonDriveManagedCachingContract(): void {
	runRemoteFamilyCachingContract("ManagedRemoteFs<protondrive>", makeCachingHarness);

	describe("ManagedRemoteFs<protondrive> event feed", () => {
		it("full-scans when the event log cannot be replayed from the cursor", async () => {
			const drive = new FakeProtonDrive();
			drive.seedFile("a.md");
			const store = new MetadataStore<RemoteObject>("managed-events-refresh", STORE);
			const fs = makeFs(drive, "managed-events-refresh", store);
			await fs.list();
			await fs.commitCheckpoint();

			drive.stageRemoteDelete("a.md");
			drive.seedFile("b.md");
			drive.expireNextEventReadOnce();
			await fs.getChangedPaths();

			expect(await fs.stat("a.md")).toBeNull();
			expect(await fs.stat("b.md")).not.toBeNull();
			await fs.close();
		});

		it("deletes the descendants of a folder trashed remotely", async () => {
			const drive = new FakeProtonDrive();
			drive.seedFolderWithChild("dir", "b.md");
			const store = new MetadataStore<RemoteObject>("managed-events-trash-folder", STORE);
			const fs = makeFs(drive, "managed-events-trash-folder", store);
			await fs.list();
			await fs.commitCheckpoint();

			drive.stageRemoteDelete("dir");
			const delta = await fs.getChangedPaths();

			expect(new Set(delta?.deleted)).toEqual(new Set(["dir", "dir/b.md"]));
			expect(await fs.stat("dir/b.md")).toBeNull();
			await fs.close();
		});
	});
}

const PROTONDRIVE_CONCURRENCY_CAPABILITIES: RemoteBackendCapabilities = {
	exclusiveCreate: true,
	conditionalContentUpdate: "none",
	conditionalMetadataMutation: false,
	versionBoundRead: "revision",
};

function makeConcurrencyHarness(): BackendConcurrencyHarness {
	const drive = new FakeProtonDrive();
	const adapter = new ProtonDriveAdapter(drive, ROOT);
	const observedToken = async (id: string): Promise<string> => (await adapter.getById(id))?.versionToken ?? "";
	return {
		adapter,
		async seed(path, content) {
			const uid = drive.seedFile(path, bytes(content), Date.now());
			return { id: uid, versionToken: await observedToken(uid) };
		},
		async seedFolder(path) {
			const folder = await drive.createFolder(ROOT, path);
			return { id: folder.uid, versionToken: await observedToken(folder.uid) };
		},
		write(id, content) {
			drive.concurrentWrite(id as NodeUid, content);
			return Promise.resolve();
		},
		writeAfterNextObservation(id, content) {
			drive.afterNextObservation(id as NodeUid, () => drive.concurrentWrite(id as NodeUid, content));
		},
		writeMetadataAfterNextObservation(id) {
			drive.afterNextObservation(id as NodeUid, () => drive.touchMetadata(id as NodeUid));
		},
		contentOf(id) {
			return Promise.resolve(drive.contentOf(id as NodeUid));
		},
		nameOf(id) {
			return drive.nameOf(id as NodeUid);
		},
		removeEvidence(id) {
			drive.markDegraded(id as NodeUid);
		},
		removeVersionEvidenceKeepContent() {},
		destination(name): DestinationAddress {
			return { addressing: "parent_id", parentId: null, name };
		},
		directoryVersionEvidence: false,
		providerDirectoryToken: () => undefined,
	};
}

export function registerProtonDriveManagedConcurrencyContract(): void {
	runBackendConcurrencyContract("protondrive adapter", PROTONDRIVE_CONCURRENCY_CAPABILITIES, makeConcurrencyHarness);
}

export function registerProtonDriveManagedChangeDetectionContract(): void {
	runRemoteChangeDetectionContract(
		"ManagedRemoteFs<protondrive>",
		async () => {
			await Promise.resolve();
			const fs = makeFs(new FakeProtonDrive(), "managed-change");
			const path = "note.md";
			return {
				observeWritten: async () => {
					await fs.write(path, bytes("version one"), Date.now());
					return statOrThrow(fs, path);
				},
				observeUnchanged: async () => statOrThrow(fs, path),
				observeAfterEdit: async () => {
					await fs.write(path, bytes("version two!"), Date.now());
					return statOrThrow(fs, path);
				},
				observeTouchedSameContent: async () => {
					await fs.write(path, bytes("version one"), Date.now() + 1000);
					return statOrThrow(fs, path);
				},
			};
		},
		{ checksumBased: true },
	);
}

interface ProtonPriorityHarness extends PriorityObservationContractHarness {
	assertIdentityReadRoute(): void;
}

async function makePriorityHarness(scenario: PriorityObservationScenario): Promise<ProtonPriorityHarness> {
	const drive = new FakeProtonDrive();
	const content = bytes("priority");
	const created = drive.seedFile("note.md", content, Date.now());
	const revision = drive.activeRevision(created)!;
	const fs = makeFs(drive, "managed-priority");
	const download = vi.spyOn(drive, "downloadRevision");
	if (scenario === "unverifiable") drive.markDegraded(created);
	let replacementKey = "replacement";
	if (scenario === "missing") await drive.trash(created);
	if (scenario === "replacement") replacementKey = drive.stageRemoteRecreateWithNewId("note.md");
	if (scenario === "changed-during-read") {
		download.mockImplementation((requested: RevisionUid) => {
			drive.concurrentWrite(created, "changed");
			return Promise.resolve({ kind: "content", bytes: requested === revision ? content.slice(0) : new ArrayBuffer(0) });
		});
	}
	return {
		fs,
		request: { path: "note.md", identityKey: created },
		expectedToken: revision,
		expectedContent: content.slice(0),
		replacementIdentityKey: replacementKey,
		assertIdentityReadRoute: () => {
			expect(download).toHaveBeenCalledWith(revision);
		},
	};
}

export function registerProtonDriveManagedPriorityObservationContract(): void {
	runPriorityObservationContract("ManagedRemoteFs<protondrive>", makePriorityHarness);

	describe("ManagedRemoteFs<protondrive> detached priority observation", () => {
		it("reads the admitted revision through the adapter", async () => {
			const harness = await makePriorityHarness("current");
			try {
				const observed = await harness.fs.priority.observe(harness.request);
				expect(observed.kind).toBe("current");
				await harness.fs.priority.read(observed as never);
				harness.assertIdentityReadRoute();
			} finally {
				await harness.fs.close?.();
			}
		});
	});
}
