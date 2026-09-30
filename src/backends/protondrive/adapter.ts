import type {
	CreateDirectoryInput,
	CreateFileInput,
	DeleteInput,
	DestinationAddress,
	ExpectedVersion,
	MoveInput,
	RemoteBackendAdapter,
	RemoteBackendCapabilities,
	RemoteChange,
	RemoteChangeResult,
	RemoteObject,
	SubtreeReadResult,
	UpdateFileInput,
	VersionBoundReadInput,
	VersionBoundReadResult,
} from "../../backend-api";
import { failBackend } from "../shared/error-shape";
import type { DriveNode, DriveUploadMetadata, EventId, NodeUid, ProtonDriveApi, RevisionUid, TreeScopeId } from "./drive-api";
import { scopeOf } from "./drive-api";
import { mediaTypeFor, projectNode } from "./normalize-object";

/** Guards a parent walk against a cycle in provider data. */
const MAX_TREE_DEPTH = 256;

async function sha1Hex(content: ArrayBuffer): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", content));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireParentId(destination: DestinationAddress): { parentId: string | null; name: string } {
	if (destination.addressing !== "parent_id") failBackend("permanent", "Proton Drive adapter requires parent_id addressing");
	return destination;
}

function assertExpectedIdentity(expected: ExpectedVersion, id: string): void {
	if (expected.id !== id) failBackend("target_changed", `Expected version names ${expected.id}, not ${id}`);
}

/** An empty expected token means core holds no version (a folder); a real one must still match. */
function assertExpectedEvidence(expected: ExpectedVersion, observed: RemoteObject, operation: string): void {
	if (expected.versionToken === "") return;
	if (observed.versionToken === undefined) failBackend("unverifiable", `Proton Drive node ${observed.id} has no version evidence for ${operation}`);
	if (observed.versionToken !== expected.versionToken) {
		failBackend("target_changed", `Proton Drive node ${observed.id} changed before ${operation}`);
	}
}

/**
 * Identity is the SDK node uid and topology its parent uid. A file's version token
 * is its active revision uid, which `read` downloads exactly. Folders carry no
 * version. The checksum is the plaintext SHA-1 the uploader stored in the
 * encrypted extended attributes.
 *
 * The event feed is volume-wide and names only touched nodes, so each delta
 * re-reads those nodes and reports their current state; core drops the ones
 * outside the bound root. A folder moved in reports no descendants, so
 * {@link listSubtreeById} completes it.
 *
 * Proton refuses a second node with the same name in a folder, but offers no
 * precondition on the active revision or on move/rename/trash.
 */
export class ProtonDriveAdapter implements RemoteBackendAdapter {
	readonly capabilities: RemoteBackendCapabilities = {
		exclusiveCreate: true,
		conditionalContentUpdate: "none",
		conditionalMetadataMutation: false,
		versionBoundRead: "revision",
	};
	readonly addressing = "parent_id" as const;

	private readonly scope: TreeScopeId;

	constructor(
		private readonly drive: ProtonDriveApi,
		private readonly rootUid: NodeUid,
	) {
		this.scope = scopeOf(rootUid);
	}

	async getStartCursor(): Promise<string> {
		return this.drive.latestEventId(this.scope);
	}

	async listAll(): Promise<readonly RemoteObject[]> {
		return this.listDescendants(this.rootUid);
	}

	async assertRootAlive(): Promise<void> {
		const root = (await this.drive.getNodes([this.rootUid])).get(this.rootUid);
		if (!root) failBackend("not_found", "Bound Proton Drive folder was not found");
		if (root.trashed) failBackend("target_changed", "Bound Proton Drive folder is in Trash");
		if (root.kind !== "folder") failBackend("target_changed", "Bound Proton Drive node is not a folder");
	}

	async getChanges(cursor: string): Promise<RemoteChangeResult> {
		const read = await this.drive.readEvents(this.scope, cursor as EventId);
		if (read.kind === "refresh") return { kind: "cursor_invalid" };
		const current = await this.drive.getNodes(read.touched);
		const changes: RemoteChange[] = [];
		for (const uid of read.touched) {
			if (uid === this.rootUid) continue;
			const node = current.get(uid);
			if (!node || node.trashed) {
				changes.push({ kind: "delete", id: uid });
				continue;
			}
			const object = await this.projectOrFail(node);
			if (object) changes.push({ kind: "upsert", object });
		}
		return { kind: "changes", nextCursor: read.lastEventId, changes };
	}

	async listSubtreeById(id: string): Promise<SubtreeReadResult> {
		return { kind: "subtree", objects: await this.listDescendants(id as NodeUid) };
	}

	async getById(id: string): Promise<RemoteObject | null> {
		return this.observe(id as NodeUid);
	}

	async getByPath(path: string): Promise<readonly RemoteObject[]> {
		if (path === "") return [];
		let parent = this.rootUid;
		const segments = path.split("/");
		for (const [index, segment] of segments.entries()) {
			const children = await this.drive.listChildren(parent);
			const matches = children.filter((child) => child.name === segment);
			if (index === segments.length - 1) {
				const objects: RemoteObject[] = [];
				for (const match of matches) {
					const object = await this.projectOrFail(match);
					if (object) objects.push(object);
				}
				return objects;
			}
			const [folder] = matches;
			if (matches.length !== 1 || !folder || folder.kind !== "folder") return [];
			parent = folder.uid;
		}
		return [];
	}

	async read(input: VersionBoundReadInput): Promise<VersionBoundReadResult> {
		const observed = await this.observe(input.id as NodeUid);
		if (observed === null) return { kind: "target_changed" };
		if (observed.kind !== "file" || observed.versionToken === undefined) {
			return { kind: "unverifiable", reason: "Proton Drive node has no revision to read" };
		}
		if (input.versionToken === "" || observed.versionToken !== input.versionToken) return { kind: "target_changed" };
		const download = await this.drive.downloadRevision(input.versionToken as RevisionUid);
		if (download.kind === "signature_invalid") {
			return { kind: "unverifiable", reason: "Proton Drive content signature did not verify" };
		}
		return { kind: "content", object: observed, content: download.bytes };
	}

	async createFile(input: CreateFileInput): Promise<RemoteObject> {
		const { parentId, name } = requireParentId(input.destination);
		const uid = await this.drive.createFile(
			(parentId ?? this.rootUid) as NodeUid,
			name,
			input.content,
			await this.uploadMetadata(name, input.content, input.mtimeMs),
		);
		return this.observeCommitted(uid);
	}

	async updateFile(input: UpdateFileInput): Promise<RemoteObject> {
		assertExpectedIdentity(input.expected, input.id);
		const observed = await this.observe(input.id as NodeUid);
		if (observed === null) failBackend("not_found", `Proton Drive file ${input.id} was not found`);
		if (observed.kind !== "file") failBackend("target_changed", `Proton Drive node ${input.id} is not a file`);
		if (observed.versionToken !== input.expected.versionToken) {
			failBackend("target_changed", `Proton Drive file ${input.id} changed before update`);
		}
		await this.drive.uploadRevision(
			observed.id as NodeUid,
			input.content,
			await this.uploadMetadata(observed.name, input.content, input.mtimeMs),
		);
		return this.observeCommitted(observed.id as NodeUid);
	}

	async createDirectory(input: CreateDirectoryInput): Promise<RemoteObject> {
		const { parentId, name } = requireParentId(input.destination);
		const folder = await this.drive.createFolder((parentId ?? this.rootUid) as NodeUid, name);
		const projection = projectNode(folder, this.rootUid);
		if (projection.kind !== "object") failBackend("transient", `Proton Drive did not report folder ${name}`);
		return projection.object;
	}

	async move(input: MoveInput): Promise<RemoteObject> {
		assertExpectedIdentity(input.expected, input.id);
		const { parentId, name } = requireParentId(input.destination);
		const observed = await this.observe(input.id as NodeUid);
		if (observed === null) failBackend("not_found", `Proton Drive node ${input.id} was not found`);
		assertExpectedEvidence(input.expected, observed, "move");
		const uid = observed.id as NodeUid;
		const currentParent = observed.location.addressing === "parent_id" ? observed.location.parentId : null;
		const targetParent = (parentId ?? this.rootUid) as NodeUid;
		// Proton has no combined move+rename: the rename lands first, in the source folder.
		if (observed.name !== name) await this.drive.rename(uid, name);
		if (currentParent !== targetParent) await this.drive.move(uid, targetParent);
		return this.observeCommitted(uid);
	}

	async delete(input: DeleteInput): Promise<void> {
		assertExpectedIdentity(input.expected, input.id);
		const observed = await this.observe(input.id as NodeUid);
		if (observed === null) return;
		assertExpectedEvidence(input.expected, observed, "delete");
		await this.drive.trash(observed.id as NodeUid);
	}

	private async uploadMetadata(name: string, content: ArrayBuffer, mtimeMs: number): Promise<DriveUploadMetadata> {
		return { mediaType: mediaTypeFor(name), sha1: await sha1Hex(content), mtimeMs };
	}

	private async listDescendants(folder: NodeUid): Promise<RemoteObject[]> {
		const objects: RemoteObject[] = [];
		const pending = [folder];
		for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
			for (const child of await this.drive.listChildren(next)) {
				const object = await this.projectOrFail(child);
				if (!object) continue;
				objects.push(object);
				if (object.kind === "directory") pending.push(child.uid);
			}
		}
		return objects;
	}

	/** Current projection, or `null` when absent, trashed or outside the sync view. */
	private async observe(uid: NodeUid): Promise<RemoteObject | null> {
		const node = (await this.drive.getNodes([uid])).get(uid);
		return node ? this.projectOrFail(node) : null;
	}

	private async observeCommitted(uid: NodeUid): Promise<RemoteObject> {
		const object = await this.observe(uid);
		if (!object) failBackend("transient", `Proton Drive did not report committed node ${uid}`);
		return object;
	}

	/** An unnamed node inside the bound root fails closed: its absence would read as a deletion. */
	private async projectOrFail(node: DriveNode): Promise<RemoteObject | null> {
		const projection = projectNode(node, this.rootUid);
		if (projection.kind === "object") return projection.object;
		if (projection.kind === "unnamed" && (await this.isUnderRoot(node))) {
			failBackend("unverifiable", `Proton Drive node ${node.uid} has a name that cannot be decrypted`);
		}
		return null;
	}

	private async isUnderRoot(node: DriveNode): Promise<boolean> {
		let parent = node.parentUid;
		for (let depth = 0; parent !== undefined && depth < MAX_TREE_DEPTH; depth++) {
			if (parent === this.rootUid) return true;
			parent = (await this.drive.getNodes([parent])).get(parent)?.parentUid;
		}
		return false;
	}
}
