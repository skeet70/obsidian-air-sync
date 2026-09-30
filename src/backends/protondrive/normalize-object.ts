import type { RemoteObject } from "../../backend-api";
import type { DriveNode, NodeUid } from "./drive-api";

/** Proton Docs/Sheets: provider-native objects with no byte content (RB-SVC-010). */
const PROTON_NATIVE_MEDIA_TYPE_PREFIX = "application/vnd.proton.";

export type Projection =
	| { readonly kind: "object"; readonly object: RemoteObject }
	/** Outside the sync view: trashed, a draft, the root itself, or not a byte-backed file/folder. */
	| { readonly kind: "excluded" }
	/** A live node whose name cannot be decrypted, so it has no path. */
	| { readonly kind: "unnamed" };

export function projectNode(node: DriveNode, rootUid: NodeUid): Projection {
	if (node.trashed || node.uid === rootUid || node.parentUid === undefined || node.kind === "other") {
		return { kind: "excluded" };
	}
	if (node.kind === "file" && (!node.revision || node.mediaType?.startsWith(PROTON_NATIVE_MEDIA_TYPE_PREFIX))) {
		return { kind: "excluded" };
	}
	if (node.name === null) return { kind: "unnamed" };
	const base = {
		id: node.uid,
		name: node.name,
		location: { addressing: "parent_id" as const, parentId: node.parentUid },
		pathAuthority: "provider_resolved" as const,
	};
	if (node.kind === "folder" || !node.revision) return { kind: "object", object: { ...base, kind: "directory" } };
	const { revision } = node;
	// A degraded file has no revision Air Sync can read, so it carries no version or content evidence.
	return {
		kind: "object",
		object: {
			...base,
			kind: "file",
			size: revision.size,
			mtimeMs: revision.mtimeMs,
			checksum: revision.sha1 && !node.degraded ? { algorithm: "sha1", value: revision.sha1 } : undefined,
			versionToken: node.degraded ? undefined : revision.uid,
		},
	};
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
	md: "text/markdown",
	txt: "text/plain",
	json: "application/json",
	canvas: "application/json",
	css: "text/css",
	csv: "text/csv",
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};

/** Proton's apps pick a preview from the stored media type. */
export function mediaTypeFor(name: string): string {
	const dot = name.lastIndexOf(".");
	const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
	return MEDIA_TYPES[extension] ?? "application/octet-stream";
}
