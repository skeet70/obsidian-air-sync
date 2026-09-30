declare const nodeUidBrand: unique symbol;
declare const revisionUidBrand: unique symbol;
declare const treeScopeIdBrand: unique symbol;
declare const eventIdBrand: unique symbol;

/** SDK node uid, `<volumeId>~<linkId>`. */
export type NodeUid = string & { readonly [nodeUidBrand]: true };
/** SDK revision uid, `<volumeId>~<linkId>~<revisionId>`. */
export type RevisionUid = string & { readonly [revisionUidBrand]: true };
/** A node's event scope: its volume id. Nodes never change scope. */
export type TreeScopeId = string & { readonly [treeScopeIdBrand]: true };
export type EventId = string & { readonly [eventIdBrand]: true };

/** The volume id prefix of a node uid. */
export function scopeOf(uid: NodeUid): TreeScopeId {
	const separator = uid.indexOf("~");
	if (separator <= 0) throw new Error(`Malformed Proton Drive node uid: ${uid}`);
	return uid.slice(0, separator) as TreeScopeId;
}

export type DriveNodeKind = "file" | "folder" | "other";

export interface DriveRevision {
	readonly uid: RevisionUid;
	/** Plaintext size the uploader claimed in the encrypted extended attributes. */
	readonly size?: number;
	readonly mtimeMs?: number;
	/** Lowercase hex SHA-1 of the plaintext, as claimed by the uploader. */
	readonly sha1?: string;
}

export interface DriveNode {
	readonly uid: NodeUid;
	/** Absent for a volume root. */
	readonly parentUid?: NodeUid;
	/** `null` when the name did not decrypt or is not a valid name. */
	readonly name: string | null;
	readonly kind: DriveNodeKind;
	readonly mediaType?: string;
	readonly trashed: boolean;
	/** The SDK reported decryption errors for the node (e.g. its node key), so its content cannot be read. */
	readonly degraded: boolean;
	/** Absent for folders and for a file whose first upload never committed. */
	readonly revision?: DriveRevision;
}

export type DriveEventRead =
	/** The volume's event log cannot be replayed from the given id. */
	| { readonly kind: "refresh" }
	| {
			readonly kind: "events";
			/** Every node the events touched, deduplicated; the caller re-reads current state. */
			readonly touched: readonly NodeUid[];
			readonly lastEventId: EventId;
	  };

export type DriveDownload =
	| { readonly kind: "content"; readonly bytes: ArrayBuffer }
	/** The content decrypted but its author signature did not verify. */
	| { readonly kind: "signature_invalid" };

export interface DriveUploadMetadata {
	readonly mediaType: string;
	readonly sha1: string;
	readonly mtimeMs: number;
}

/**
 * The Proton Drive operations the adapter uses, over the official SDK
 * (`sdk.ts`) or a test double. Failures are thrown as `BackendErrorShape` errors.
 */
export interface ProtonDriveApi {
	getMyFilesRoot(): Promise<DriveNode>;
	/** A missing or inaccessible uid is absent from the map. */
	getNodes(uids: readonly NodeUid[]): Promise<ReadonlyMap<NodeUid, DriveNode>>;
	/** Every non-trashed direct child, completely drained. */
	listChildren(folder: NodeUid): Promise<readonly DriveNode[]>;
	latestEventId(scope: TreeScopeId): Promise<EventId>;
	readEvents(scope: TreeScopeId, since: EventId): Promise<DriveEventRead>;
	downloadRevision(revision: RevisionUid): Promise<DriveDownload>;
	createFile(parent: NodeUid, name: string, content: ArrayBuffer, metadata: DriveUploadMetadata): Promise<NodeUid>;
	/** Upload a new active revision; Proton rejects it if the active revision changed first. */
	uploadRevision(file: NodeUid, content: ArrayBuffer, metadata: DriveUploadMetadata): Promise<void>;
	createFolder(parent: NodeUid, name: string): Promise<DriveNode>;
	rename(node: NodeUid, name: string): Promise<void>;
	move(node: NodeUid, parent: NodeUid): Promise<void>;
	trash(node: NodeUid): Promise<void>;
}
