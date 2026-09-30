import { Setting } from "../platform/obsidian";
import type { App, TextComponent } from "../platform/obsidian";
import { APP_ROOT_FOLDER_PATH_KEY } from "../backend-api";
import type { AirSyncSettings } from "../settings";
import type { BackendConnectionActions } from "../fs/settings-renderer";
import type { RemoteVaultDisplay } from "../fs/backend";
import { AppFolderPickerModal, type AppFolderPickerProvider } from "./app-folder-picker";

/**
 * Render the shared "Connection status" row: a ●-prefixed status line (colored via
 * the `air-sync-status-connected`/`-disconnected` classes) plus a Connect/Disconnect
 * button. Used by every backend renderer.
 *
 * `onConnect` overrides the default `startAuth` for backends that must guard first
 * (e.g. Google Drive custom requires a folder id) — return `false` from it to abort
 * without refreshing the display.
 */
export function renderConnectionStatus(
	containerEl: HTMLElement,
	opts: {
		connected: boolean;
		connectLabel: string;
		actions: BackendConnectionActions;
		onConnect?: () => Promise<boolean | void> | boolean | void;
	},
): void {
	const { connected, connectLabel, actions } = opts;
	const setting = new Setting(containerEl)
		.setName("Connection status")
		.setDesc(connected ? "● Connected" : "● Not connected");
	setting.settingEl.addClass(connected ? "air-sync-status-connected" : "air-sync-status-disconnected");
	setting.addButton((button) =>
		button
			.setButtonText(connected ? "Disconnect" : connectLabel)
			.onClick(async () => {
				if (connected) {
					await actions.disconnect();
				} else if (opts.onConnect) {
					if ((await opts.onConnect()) === false) return;
				} else {
					await actions.startAuth();
				}
				actions.refreshDisplay();
			}),
	);
}

/** The resolved bound-folder display, as every provider returns it. */
export type ResolvedFolderDisplay = RemoteVaultDisplay;

/**
 * Render the bound remote-folder field: a disabled text field showing the folder id
 * IMMEDIATELY (never block on a network call), then best-effort upgraded to the
 * id-resolved display path. A slow/failed/never-settling lookup just leaves the id
 * shown — it must never stick on a "Resolving…" placeholder. A warning replaces the
 * description so an unusable bound folder does not read as an ordinary location.
 */
export function renderBoundFolderField(
	folderSetting: Setting,
	opts: {
		desc: string;
		folderId: string;
		resolvePath?: () => Promise<ResolvedFolderDisplay | null | undefined> | undefined;
	},
): void {
	folderSetting.setDesc(opts.desc);
	let pathField: TextComponent | undefined;
	folderSetting.addText((text) => {
		pathField = text.setValue(opts.folderId).setDisabled(true);
	});
	void opts.resolvePath?.()
		?.then((display) => {
			if (!display) return;
			if (display.path) pathField?.setValue(display.path);
			if (display.warning) folderSetting.setDesc(display.warning);
		})
		.catch(() => { /* keep the id shown */ });
}

/**
 * Render the unbound remote-folder field for a module with the in-app picker over the
 * provider's app folder: a default-folder CTA button and a "Choose folder" button that
 * opens the shared {@link AppFolderPickerModal}.
 */
export function renderUnboundAppFolderField(
	folderSetting: Setting,
	opts: {
		app: App;
		settings: AirSyncSettings;
		provider: AppFolderPickerProvider | undefined;
		defaultLabel: string;
		modalTitle: string;
		onSave: (updates: Record<string, unknown>) => Promise<void>;
		actions: BackendConnectionActions;
	},
): void {
	const { app, settings, provider, defaultLabel, modalTitle, onSave, actions } = opts;
	folderSetting.setDesc(
		"Choose where this vault syncs: use the default folder, or pick an existing one inside the app folder.",
	);
	folderSetting
		.addButton((button) =>
			button
				.setButtonText(defaultLabel)
				.setCta()
				.onClick(async () => {
					// Clear any folder name queued by the modal first: the default button
					// always binds the default folder.
					await onSave({ pendingPickedFolderPath: "" });
					await actions.bindDefaultFolder();
				}),
		)
		.addButton((button) =>
			button
				.setButtonText("Choose folder")
				.onClick(() => {
					if (!provider) return;
					new AppFolderPickerModal(app, modalTitle, undefined, provider, settings, async (folderPath) => {
						await onSave({ pendingPickedFolderPath: folderPath });
						await actions.bindDefaultFolder();
					}).open();
				}),
		);
}

/**
 * Render the unbound remote-folder field for a module declaring `binding.appRoot`: a
 * text input editing {@link APP_ROOT_FOLDER_PATH_KEY}, with the module's default path
 * as placeholder. Once `connected`, "Choose folder" opens the picker and "Use this
 * folder" binds the typed path, or the default when it is empty.
 */
export function renderUnboundAppRootFolderField(
	folderSetting: Setting,
	opts: {
		app: App;
		settings: AirSyncSettings;
		provider: AppFolderPickerProvider;
		rootName: string;
		defaultPath: string;
		modalTitle: string;
		connected: boolean;
		onSave: (updates: Record<string, unknown>) => Promise<void>;
		actions: BackendConnectionActions;
	},
): void {
	const { app, settings, provider, rootName, defaultPath, modalTitle, connected, onSave, actions } = opts;
	const current = settings.backendData[APP_ROOT_FOLDER_PATH_KEY];
	folderSetting.setDesc(`Folder path in ${rootName}. Leave empty for the default.`);
	let saved: Promise<void> = Promise.resolve();
	folderSetting.addText((text) =>
		text
			.setPlaceholder(defaultPath)
			.setValue(typeof current === "string" ? current : "")
			.onChange((value) => {
				saved = onSave({ [APP_ROOT_FOLDER_PATH_KEY]: value });
			}),
	);
	if (!connected) return;
	folderSetting
		.addButton((button) =>
			button.setButtonText("Choose folder").onClick(() => {
				new AppFolderPickerModal(app, modalTitle, rootName, provider, settings, async (folderPath) => {
					await onSave({ [APP_ROOT_FOLDER_PATH_KEY]: folderPath });
					await actions.bindDefaultFolder();
				}).open();
			}),
		)
		.addButton((button) =>
			button
				.setButtonText("Use this folder")
				.setCta()
				.onClick(async () => {
					// The bind reads the key, so the last keystroke's save must land first.
					await saved;
					await actions.bindDefaultFolder();
				}),
		);
}
