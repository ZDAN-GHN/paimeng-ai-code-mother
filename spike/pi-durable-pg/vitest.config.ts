import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// One storage holds a session advisory lock; run files (and cases) serially.
		fileParallelism: false,
		sequence: { concurrent: false },
		testTimeout: 30_000,
	},
});
