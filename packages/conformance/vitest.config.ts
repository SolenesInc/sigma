import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { packageTargets } from "./resolve.ts";

// CONFORMANCE_TARGET is the tree behind the suite's @earendil-works imports. run.ts also links the same tree's
// durable/src into upstream/src, because some tests spawn fixtures that import ../../src directly.
const root = import.meta.dirname;
const targetRoot = resolve(root, process.env.CONFORMANCE_TARGET ?? "adapter");
const targets = packageTargets();

export default defineConfig({
	root,
	plugins: [
		{
			name: "conformance-resolve",
			enforce: "pre",
			resolveId(source, importer) {
				if (source === "@earendil-works/pi-durable/testing") return join(root, "upstream/src/testing/index.ts");
				if (source.startsWith("@earendil-works/")) {
					const mapped = targets(source);
					if (mapped === undefined) throw new Error(`conformance: no target for ${source}`);
					return join(targetRoot, mapped);
				}
				return undefined;
			},
		},
	],
	test: {
		include: ["upstream/test/**/*.test.ts", "amended/**/*.test.ts"],
		environment: "node",
		// A tripwire past a busy machine: vitest's 5 s default timed out tools-images, harness-context and env-node rows
		// in 3 of 22 of sigma's gate runs at load average 15 to 40. The slowest of those rows took 7.0 s under load 32 to
		// 43 on a 10-core M5 (prepares concurrent images, evict mode), and 0.5 s at rest.
		testTimeout: 30_000,
		setupFiles: ["./upstream/test/setup-document-retention.ts", "./setup-rows.ts", "./setup-timeout-message.ts"],
	},
});
