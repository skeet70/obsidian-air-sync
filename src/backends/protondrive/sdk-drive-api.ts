import type { NodeEntity, ProtonDriveClient, UploadMetadata } from "@protontech/drive-sdk";
import { DriveEventType, NodeType } from "@protontech/drive-sdk";
import { failBackend, toBackendError } from "../shared/error-shape";
import type {
	DriveDownload,
	DriveEventRead,
	DriveNode,
	DriveUploadMetadata,
	EventId,
	NodeUid,
	ProtonDriveApi,
	RevisionUid,
	TreeScopeId,
} from "./drive-api";
import { translateProtonError } from "./errors";

async function guard<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		throw toBackendError(translateProtonError(err));
	}
}

/** The SDK/`DriveNode` parse boundary. */
export function toDriveNode(node: NodeEntity): DriveNode {
	const revision = node.activeRevision;
	return {
		uid: node.uid as NodeUid,
		parentUid: node.parentUid as NodeUid | undefined,
		name: node.name.ok ? node.name.value : null,
		kind: node.type === NodeType.File ? "file" : node.type === NodeType.Folder ? "folder" : "other",
		mediaType: node.mediaType,
		trashed: node.trashTime !== undefined,
		degraded: (node.errors?.length ?? 0) > 0,
		revision: revision && {
			uid: revision.uid as RevisionUid,
			size: revision.claimedSize,
			mtimeMs: revision.claimedModificationTime?.getTime(),
			sha1: revision.claimedDigests?.sha1?.toLowerCase(),
		},
	};
}

function toUploadMetadata(content: ArrayBuffer, metadata: DriveUploadMetadata): UploadMetadata {
	return {
		mediaType: metadata.mediaType,
		expectedSize: content.byteLength,
		expectedSha1: metadata.sha1,
		modificationTime: new Date(metadata.mtimeMs),
	};
}

async function drainResults(results: AsyncIterable<{ ok: true } | { ok: false; error: Error }>): Promise<void> {
	for await (const result of results) {
		if (!result.ok) throw result.error;
	}
}

export class SdkDriveApi implements ProtonDriveApi {
	constructor(private readonly client: ProtonDriveClient) {}

	getMyFilesRoot(): Promise<DriveNode> {
		return guard(async () => toDriveNode(await this.client.getMyFilesRootFolder()));
	}

	getNodes(uids: readonly NodeUid[]): Promise<ReadonlyMap<NodeUid, DriveNode>> {
		return guard(async () => {
			const nodes = new Map<NodeUid, DriveNode>();
			if (uids.length === 0) return nodes;
			for await (const node of this.client.iterateNodes([...uids])) {
				if ("missingUid" in node) continue;
				const parsed = toDriveNode(node);
				nodes.set(parsed.uid, parsed);
			}
			return nodes;
		});
	}

	listChildren(folder: NodeUid): Promise<readonly DriveNode[]> {
		return guard(async () => {
			const uids: NodeUid[] = [];
			for await (const uid of this.client.iterateFolderChildrenNodeUids(folder)) uids.push(uid as NodeUid);
			const nodes = await this.getNodes(uids);
			return [...nodes.values()].filter((node) => !node.trashed);
		});
	}

	latestEventId(scope: TreeScopeId): Promise<EventId> {
		return guard(async () => {
			for await (const event of this.client.iterateEvents(scope)) {
				if (event.type === DriveEventType.FastForward) return event.eventId as EventId;
			}
			return failBackend("transient", "Proton did not report the latest event id");
		});
	}

	readEvents(scope: TreeScopeId, since: EventId): Promise<DriveEventRead> {
		return guard(async () => {
			const touched = new Set<NodeUid>();
			let lastEventId = since;
			for await (const event of this.client.iterateEvents(scope, since)) {
				switch (event.type) {
					case DriveEventType.TreeRefresh:
						return { kind: "refresh" };
					case DriveEventType.TreeRemove:
						return failBackend("not_found", "The Proton Drive volume is no longer accessible");
					case DriveEventType.NodeCreated:
					case DriveEventType.NodeUpdated:
					case DriveEventType.NodeDeleted:
						touched.add(event.nodeUid as NodeUid);
						lastEventId = event.eventId as EventId;
						break;
					default:
						lastEventId = event.eventId as EventId;
				}
			}
			return { kind: "events", touched: [...touched], lastEventId };
		});
	}

	downloadRevision(revision: RevisionUid): Promise<DriveDownload> {
		return guard(async () => {
			const downloader = await this.client.getFileRevisionDownloader(revision);
			const chunks: Uint8Array[] = [];
			const sink = new WritableStream<Uint8Array>({
				write(chunk) {
					chunks.push(chunk);
				},
			});
			const controller = downloader.downloadToStream(sink);
			try {
				await controller.completion();
			} catch (err) {
				if (controller.isDownloadCompleteWithSignatureIssues()) return { kind: "signature_invalid" };
				throw err;
			}
			const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return { kind: "content", bytes: bytes.buffer };
		});
	}

	createFile(parent: NodeUid, name: string, content: ArrayBuffer, metadata: DriveUploadMetadata): Promise<NodeUid> {
		return guard(async () => {
			const uploader = await this.client.getFileUploader(parent, name, toUploadMetadata(content, metadata));
			const controller = await uploader.uploadFromStream(new Blob([content]).stream(), []);
			return (await controller.completion()).nodeUid as NodeUid;
		});
	}

	uploadRevision(file: NodeUid, content: ArrayBuffer, metadata: DriveUploadMetadata): Promise<void> {
		return guard(async () => {
			const uploader = await this.client.getFileRevisionUploader(file, toUploadMetadata(content, metadata));
			const controller = await uploader.uploadFromStream(new Blob([content]).stream(), []);
			await controller.completion();
		});
	}

	createFolder(parent: NodeUid, name: string): Promise<DriveNode> {
		return guard(async () => toDriveNode(await this.client.createFolder(parent, name)));
	}

	rename(node: NodeUid, name: string): Promise<void> {
		return guard(async () => {
			await this.client.renameNode(node, name);
		});
	}

	move(node: NodeUid, parent: NodeUid): Promise<void> {
		return guard(() => drainResults(this.client.moveNodes([node], parent)));
	}

	trash(node: NodeUid): Promise<void> {
		return guard(() => drainResults(this.client.trashNodes([node])));
	}
}
