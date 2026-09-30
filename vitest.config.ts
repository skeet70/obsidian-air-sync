import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
		exclude: [
			"src/backends/googledrive/test-helpers.test.ts",
		],
		server: {
			deps: {
				// @protontech/crypto ships raw TypeScript, which Node will not strip under node_modules.
				inline: [/@protontech\//],
			},
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			// Ratchet floors: set a few points below current coverage so a
			// regression fails CI, while leaving headroom for refactors. Raise
			// these as coverage improves — do not lower them to make CI pass.
			thresholds: {
				lines: 76,
				statements: 75,
				functions: 70,
				branches: 65,
			},
			// Production code only: test contracts live outside src, so this
			// denominator excludes only colocated tests/doubles and pure types.
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/**/*.d.ts",
				"src/__mocks__/**",
				"src/**/test-helpers.ts",
				"src/**/types.ts",
				"src/main.ts",
			],
		},
	},
	resolve: {
		alias: [
			{ find: "obsidian", replacement: "./src/__mocks__/obsidian.ts" },
			// openpgp exports its lightweight build to browsers only; Node gets the full build.
			{ find: /^openpgp\/lightweight$/, replacement: "openpgp" },
		],
	},
});
