import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { __ui } from "../__mocks__/obsidian";
import { BackendModuleSettingsRenderer } from "./backend-module-provider-settings";
import type { BackendModuleProvider } from "../fs/modules/backend-module-provider";
import type { BackendConnectionActions } from "../fs/settings-renderer";
import type { AirSyncSettings } from "../settings";
import type { BackendBinding } from "../backend-api";
import { mockSettings } from "../__mocks__/sync-test-helpers";
import { createFakeModule } from "../../tests/backend-api/fake-module";
import { googleDriveModule } from "../backends/googledrive/module";

vi.mock("obsidian");

beforeEach(() => {
	__ui.buttons = [];
	__ui.texts = [];
	__ui.notices = [];
});

/** A container whose `createDiv()` returns a clearable child, as the renderer expects. */
function container(): HTMLElement {
	const child = { empty: () => undefined } as unknown as HTMLElement;
	return { createDiv: () => child } as unknown as HTMLElement;
}

/** A fake provider whose module declares the two required custom credentials. */
function customAppRenderer(
	hasCredentials: boolean,
	unresolvedSecretReferences: readonly string[] = [],
): BackendModuleSettingsRenderer {
	const module = createFakeModule({
		settings: {
			fields: [
				{ key: "customClientId", label: "Client ID", type: "text" },
				{ key: "customClientSecret", label: "Client secret", type: "text" },
			],
		},
	});
	const provider = {
		type: module.id,
		getModule: () => module,
		hasCredentials: () => hasCredentials,
		unresolvedSecretReferences: () => [...unresolvedSecretReferences],
	} as unknown as BackendModuleProvider;
	return new BackendModuleSettingsRenderer(provider);
}

function actionsSpy(): { actions: BackendConnectionActions; startAuth: Mock; bindDefaultFolder: Mock } {
	const startAuth = vi.fn().mockResolvedValue(undefined);
	const bindDefaultFolder = vi.fn().mockResolvedValue(undefined);
	const actions = {
		startAuth,
		completeAuth: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		refreshDisplay: vi.fn(),
		startFolderPick: vi.fn().mockResolvedValue(undefined),
		bindDefaultFolder,
	} as unknown as BackendConnectionActions;
	return { actions, startAuth, bindDefaultFolder };
}

function connectButton(): { name: string; click: () => void } {
	const button = __ui.buttons.find((item) => item.name === "Connection status");
	if (!button) throw new Error("connection-status button was not rendered");
	return button;
}

/**
 * Regression: the module settings renderer must not clear the whole settings tab.
 * `renderBackendSettings` empties the container it is given on every re-render, so
 * handing it the tab erased the global sections drawn above it (conflict strategy,
 * remote-backend selector).
 */
describe("BackendModuleSettingsRenderer — container ownership", () => {
	it("renders module fields into a child container and never empties the tab", () => {
		const childEmpty = vi.fn();
		const child = { empty: childEmpty } as unknown as HTMLElement;
		const rootEmpty = vi.fn();
		const createDiv = vi.fn(() => child);
		const root = { empty: rootEmpty, createDiv } as unknown as HTMLElement;

		const module = createFakeModule();
		const provider = {
			type: module.id,
			getModule: () => module,
			hasCredentials: () => false,
		} as unknown as BackendModuleProvider;

		new BackendModuleSettingsRenderer(provider).render(
			root,
			{ backendData: {} } as unknown as AirSyncSettings,
			() => Promise.resolve(),
			{} as never,
			{} as never,
		);

		expect(createDiv).toHaveBeenCalled();
		// The declarative fields are cleared/redrawn inside their own child container.
		expect(childEmpty).toHaveBeenCalled();
		// The tab itself is never cleared, so the global sections survive.
		expect(rootEmpty).not.toHaveBeenCalled();
	});
});

/**
 * Regression: the unbound non-App-Folder binding row showed an opaque "Use default
 * folder" label. It must show the actual default remote path so the user can verify
 * where the vault will sync (the legacy Google Drive renderer did).
 */
describe("BackendModuleSettingsRenderer — unbound default folder", () => {
	it("labels the default-folder CTA with the resolved default remote path", () => {
		const provider = {
			type: "googledrive",
			getModule: () => googleDriveModule,
			hasCredentials: () => true,
			getRemoteVaultDisplayPath: () => Promise.resolve(null),
		} as unknown as BackendModuleProvider;
		const settings = mockSettings({ backendType: "googledrive", backendData: {} });
		const app = { vault: { getName: () => "Personal" } };

		new BackendModuleSettingsRenderer(provider).render(
			container(),
			settings,
			() => Promise.resolve(),
			actionsSpy().actions,
			app as never,
		);

		const labels = __ui.buttons.map((button) => button.label);
		expect(labels).toContain("obsidian-air-sync/Personal");
		expect(labels).not.toContain("Use default folder");
	});
});

describe("BackendModuleSettingsRenderer — in-app folder picker", () => {
	function renderUnbound(binding: BackendBinding): string[] {
		const module = createFakeModule({ binding });
		const provider = {
			type: module.id,
			getModule: () => module,
			hasCredentials: () => true,
		} as unknown as BackendModuleProvider;
		const app = { vault: { getName: () => "Personal" } };
		new BackendModuleSettingsRenderer(provider).render(
			container(),
			mockSettings({ backendType: module.id, backendData: {} }),
			() => Promise.resolve(),
			actionsSpy().actions,
			app as never,
		);
		return __ui.buttons.filter((button) => button.name === "Remote vault folder").map((button) => button.label);
	}
	const resolveDefault: BackendBinding["resolveDefault"] = () =>
		Promise.resolve({ patch: {}, target: { id: "root" } });

	it("labels the default /<vault> when the module declares no app root", () => {
		expect(renderUnbound({ resolveDefault, listAppRootFolders: () => Promise.resolve([]) })).toEqual([
			"/Personal",
			"Choose folder",
		]);
	});

	it("offers no picker to a module without listAppRootFolders or a web picker", () => {
		expect(renderUnbound({ resolveDefault })).toEqual(["obsidian-air-sync/Personal"]);
	});
});

describe("BackendModuleSettingsRenderer — app-root Remote folder row", () => {
	const binding: BackendBinding = {
		resolveDefault: () => Promise.resolve({ patch: {}, target: { id: "root" } }),
		listAppRootFolders: () => Promise.resolve([]),
		appRoot: { name: "My files", defaultFolderPath: (vault) => `obsidian-air-sync/${vault}` },
	};

	function renderRow(opts: { connected: boolean; backendData?: Record<string, unknown> }) {
		const module = createFakeModule({ binding });
		const provider = {
			type: module.id,
			getModule: () => module,
			hasCredentials: () => opts.connected,
			getRemoteVaultDisplayPath: () => Promise.resolve({ path: "/notes/notes" }),
			createUiClient: () => ({ listAppRootFolders: () => Promise.resolve([{ name: "notes" }]) }),
		} as unknown as BackendModuleProvider;
		const settings = mockSettings({ backendType: module.id, backendData: opts.backendData ?? {} });
		const onSave = (updates: Record<string, unknown>): Promise<void> => {
			settings.backendData = { ...settings.backendData, ...updates };
			return Promise.resolve();
		};
		const { actions, bindDefaultFolder } = actionsSpy();
		new BackendModuleSettingsRenderer(provider).render(
			container(),
			settings,
			onSave,
			actions,
			{ vault: { getName: () => "Personal" } } as never,
		);
		const row = __ui.texts.find((text) => text.name === "Remote folder");
		const rowButtons = __ui.buttons.filter((button) => button.name === "Remote folder");
		return { row, rowButtons, settings, bindDefaultFolder };
	}

	it("unbound and connected: an input with the default as placeholder, Choose folder and Use this folder", async () => {
		const { row, rowButtons, settings, bindDefaultFolder } = renderRow({ connected: true });

		expect(row?.placeholder).toBe("obsidian-air-sync/Personal");
		expect(row?.disabled).toBe(false);
		expect(row?.description).toBe("Folder path in My files. Leave empty for the default.");
		expect(rowButtons.map((button) => button.label)).toEqual(["Choose folder", "Use this folder"]);
		expect(__ui.buttons.some((button) => button.name === "Remote vault folder")).toBe(false);

		await row?.change("notes/notes");
		rowButtons.find((button) => button.label === "Use this folder")?.click();

		await vi.waitFor(() => expect(bindDefaultFolder).toHaveBeenCalledTimes(1));
		expect(settings.backendData.folderPath).toBe("notes/notes");
	});

	it("the picker writes the chosen path to the folder-path key and binds it", async () => {
		const { rowButtons, settings, bindDefaultFolder } = renderRow({ connected: true, backendData: { folderPath: "old" } });

		rowButtons.find((button) => button.label === "Choose folder")?.click();
		const modalPath = await vi.waitFor(() => {
			const text = __ui.texts.find((candidate) => candidate.name === "Folder path");
			if (!text) throw new Error("picker not open yet");
			return text;
		});
		await modalPath.change("notes/work");
		__ui.buttons.find((button) => button.label === "Use this folder")?.click();

		await vi.waitFor(() => expect(bindDefaultFolder).toHaveBeenCalledTimes(1));
		expect(settings.backendData.folderPath).toBe("notes/work");
		expect(settings.backendData).not.toHaveProperty("pendingPickedFolderPath");
	});

	it("not connected: the input shows the stored path and no bind buttons", async () => {
		const { row, rowButtons, settings } = renderRow({ connected: false, backendData: { folderPath: "notes/notes" } });

		expect(row?.value).toBe("notes/notes");
		expect(row?.placeholder).toBe("obsidian-air-sync/Personal");
		expect(rowButtons).toEqual([]);

		await row?.change("notes");
		expect(settings.backendData.folderPath).toBe("notes");
	});

	it("bound: shows the bound path read-only and says to disconnect to change it", async () => {
		const { row, rowButtons } = renderRow({ connected: true, backendData: { rootId: "folder-1", folderPath: "notes/notes" } });

		await vi.waitFor(() => expect(row?.value).toBe("/notes/notes"));
		expect(row?.disabled).toBe(true);
		expect(row?.description).toContain("Disconnect to change it");
		expect(rowButtons).toEqual([]);
	});
});

/**
 * Public action path: the rendered Connect button must route through the module's
 * custom-app guard before opening the browser. The guard was lost once already, so
 * this drives the actual button rather than calling the private helper.
 */
describe("BackendModuleSettingsRenderer — custom-app connect guard", () => {
	it("does not start auth when a required custom credential is absent, and notifies", () => {
		const settings = mockSettings({
			backendType: "fakebackend",
			backendData: { authMode: true },
		});
		const { actions, startAuth } = actionsSpy();

		customAppRenderer(false).render(
			container(),
			settings,
			() => Promise.resolve(),
			actions,
			{} as never,
		);

		connectButton().click();

		expect(startAuth).not.toHaveBeenCalled();
		expect(__ui.notices).toContain("Client ID is required");
	});

	it("starts auth when authMode is custom and every required field is present", () => {
		const settings = mockSettings({
			backendType: "fakebackend",
			backendData: { authMode: true, customClientId: "id", customClientSecret: "name" },
		});
		const { actions, startAuth } = actionsSpy();

		customAppRenderer(false).render(
			container(),
			settings,
			() => Promise.resolve(),
			actions,
			{} as never,
		);

		connectButton().click();

		expect(startAuth).toHaveBeenCalledTimes(1);
		expect(__ui.notices).toHaveLength(0);
	});

	it("does not open the browser when a present reference does not resolve, and names the secret", () => {
		const settings = mockSettings({
			backendType: "fakebackend",
			backendData: {
				authMode: true,
				customClientId: "missing-secret",
				customClientSecret: "name",
			},
		});
		const { actions, startAuth } = actionsSpy();

		customAppRenderer(false, ["customClientId"]).render(
			container(),
			settings,
			() => Promise.resolve(),
			actions,
			{} as never,
		);

		connectButton().click();

		expect(startAuth).not.toHaveBeenCalled();
		expect(__ui.notices).toContain(
			`The secret "missing-secret" for Client ID was not found in Obsidian's key store.`,
		);
	});
});
