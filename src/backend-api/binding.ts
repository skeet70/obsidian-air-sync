import type { JsonObject } from "./json";
import type { BackendRuntimeContext } from "./runtime";

/**
 * The stable target a connection is bound to. `id` is unique within the
 * provider/account namespace; `displayPath` is human-readable and MUST NOT be
 * used to derive identity. Core composes the global identity from module id +
 * `target.id` — a module never invents a cross-backend identity string.
 */
export interface BackendTarget {
	readonly id: string;
	readonly displayPath?: string;
	/**
	 * Optional display-only note when the target is present but not usable (e.g. it
	 * is in the provider's trash). It is NEVER part of identity: core compares
	 * targets by `id` alone. `getTarget` must not set it.
	 */
	readonly warning?: string;
}

/**
 * A patch against the active backendData bag: top-level `set`/`unset` only.
 * It never targets global settings, secret values, cursors, or metadata
 * snapshots; nested changes are expressed as an explicit replacement of the
 * relevant top-level field.
 */
export interface JsonPatch {
	readonly set?: Readonly<JsonObject>;
	readonly unset?: readonly string[];
}

export interface BindingResult {
	readonly patch: JsonPatch;
	readonly target: BackendTarget;
}

/**
 * The binding workflows a module supports. A module returns patches and a
 * target; it never mutates global settings directly. Core renders the picker
 * modal and owns the connection lifecycle.
 */
export interface BackendBinding {
	/** Find or create this vault's default remote folder. */
	resolveDefault(
		context: BackendRuntimeContext,
		config: Readonly<JsonObject>,
		vaultName: string,
	): Promise<BindingResult>;

	/** Begin a web/in-app folder pick; returns e.g. a CSRF state to persist. */
	beginPick?(
		context: BackendRuntimeContext,
		config: Readonly<JsonObject>,
	): Promise<JsonPatch>;

	/** Bind the folder selected by {@link beginPick}, given the callback params. */
	completePick?(
		context: BackendRuntimeContext,
		params: Readonly<Record<string, string>>,
		config: Readonly<JsonObject>,
	): Promise<BindingResult>;

	/** Resolve the bound target's current display location, if the backend can. */
	getDisplayPath?(
		context: BackendRuntimeContext,
		config: Readonly<JsonObject>,
		target: BackendTarget,
	): Promise<BackendTarget | null>;

	/**
	 * List the folder names directly under the picker root, for the core in-app folder
	 * picker. Declaring it gives the module that picker, which writes the pick to config
	 * (see {@link appRoot}) and binds it through {@link resolveDefault}. Core renders
	 * the modal; this only returns facts.
	 */
	listAppRootFolders?(
		context: BackendRuntimeContext,
		config: Readonly<JsonObject>,
	): Promise<readonly string[]>;

	/**
	 * Where the module's vault folder lives when it is not the provider's app folder.
	 * A module declaring it reads a `/`-separated nested path under the root from
	 * {@link APP_ROOT_FOLDER_PATH_KEY}, which core's "Remote folder" row and in-app
	 * picker write, and binds it through {@link resolveDefault}. Omitted: the root is
	 * the provider's app folder, the pick goes to `pendingPickedFolderPath`, and the
	 * unpicked default is `/<vault>`.
	 */
	readonly appRoot?: BackendAppRoot;
}

/** The config key holding an {@link BackendAppRoot} module's folder path under its root. */
export const APP_ROOT_FOLDER_PATH_KEY = "folderPath";

export interface BackendAppRoot {
	/** Shown to the user, e.g. "My files". */
	readonly name: string;
	/** The folder {@link BackendBinding.resolveDefault} binds when {@link APP_ROOT_FOLDER_PATH_KEY} is empty, relative to the root. */
	defaultFolderPath(vaultName: string): string;
}
