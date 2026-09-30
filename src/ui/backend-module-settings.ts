import { Setting } from "../platform/obsidian";
import type {
	BackendSettingField,
	BackendSettingsDefinition,
	JsonObject,
	JsonValue,
} from "../backend-api";
import {
	resolveFieldValue,
	validateBackendSettings,
	validateSettingField,
	visibleFields,
} from "../fs/modules/settings-definition";

/**
 * Core-owned view of a module's declarative settings.
 *
 * A module never imports DOM, `App`, or a settings tab: it returns a
 * {@link BackendSettingsDefinition} and core renders it here with Obsidian
 * `Setting`. The host supplies the current config bag and receives typed updates;
 * a secret value is never read into or written from this layer — a
 * `secret_reference` field holds a non-secret reference name only.
 */
export interface BackendSettingsHost {
	/** The latest active config bag (read fresh on every render). */
	config(): Readonly<JsonObject>;
	/** Persist one top-level field of the active config bag. */
	setValue(key: string, value: JsonValue): void | Promise<void>;
}

/** How a control reports a change back to {@link renderBackendSettings}. */
interface ControlCallbacks {
	/** A discrete choice (toggle, select): persist and re-render. */
	choose(value: JsonValue): void;
	/** A keystroke: persist without re-rendering, so the input keeps focus. */
	type(value: string): void;
	blur(): void;
}

function renderControl(
	setting: Setting,
	field: BackendSettingField,
	value: JsonValue | undefined,
	callbacks: ControlCallbacks,
): void {
	switch (field.type) {
		case "toggle":
			setting.addToggle((toggle) =>
				toggle
					.setValue(value === true)
					.onChange((next) => callbacks.choose(next)),
			);
			return;
		case "select":
			setting.addDropdown((dropdown) => {
				for (const option of field.options ?? []) {
					dropdown.addOption(option.value, option.label);
				}
				if (typeof value === "string") dropdown.setValue(value);
				dropdown.onChange((next) => callbacks.choose(next));
			});
			return;
		case "secret_reference":
		case "text":
		default:
			setting.addText((text) => {
				if (typeof value === "string") text.setValue(value);
				text.onChange((next) => callbacks.type(next));
				text.inputEl.addEventListener("blur", () => callbacks.blur());
			});
	}
}

function description(field: BackendSettingField, issue: string | null | undefined): string {
	const help = field.description ?? "";
	return issue ? (help ? `${help} — ${issue}` : issue) : help;
}

function visibleKeys(definition: BackendSettingsDefinition, config: Readonly<JsonObject>): string {
	return visibleFields(definition, config).map((field) => field.key).join("\n");
}

/**
 * Render `definition` into a fresh child of `parent`. A toggle or select change
 * re-renders the subtree in place; typing in a text field does not, and re-renders
 * on blur only if it changed which fields are visible. `parent` is never emptied:
 * this owns only the subtree it creates, so a caller can compose it with other
 * sections of the same settings tab.
 */
export function renderBackendSettings(
	parent: HTMLElement,
	definition: BackendSettingsDefinition,
	host: BackendSettingsHost,
): void {
	const root = parent.createDiv();
	let drawnKeys = "";
	const draw = (): void => {
		const config = host.config();
		const issues = new Map(
			validateBackendSettings(definition, config).map((issue) => [issue.key, issue.message]),
		);
		drawnKeys = visibleKeys(definition, config);
		root.empty();
		for (const field of visibleFields(definition, config)) {
			const setting = new Setting(root).setName(field.label);
			setting.setDesc(description(field, issues.get(field.key)));
			const save = (next: JsonValue): Promise<void> =>
				Promise.resolve(host.setValue(field.key, next));
			renderControl(setting, field, resolveFieldValue(field, config), {
				choose: (next) => void save(next).then(draw),
				type: (next) =>
					void save(next).then(() =>
						setting.setDesc(description(field, validateSettingField(field, next))),
					),
				blur: () => {
					if (visibleKeys(definition, host.config()) !== drawnKeys) draw();
				},
			});
		}
	};
	draw();
}
