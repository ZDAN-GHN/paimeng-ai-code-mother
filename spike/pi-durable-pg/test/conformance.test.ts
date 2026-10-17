/**
 * Runs the framework's official storage conformance suite against the Postgres
 * backend. Every case gets a clean schema and a freshly opened storage, so the
 * suite's assumptions (ID 1 reserved for the root conversation, a fresh
 * `next_id` of 2) hold exactly as they do for a new SQLite file.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { PostgresStorage, resetPostgresStorage } from "../src/pg-storage.ts";

const context = BACKGROUND_CONTEXT;

async function withStorage(use: (storage: PostgresStorage) => Promise<void>): Promise<void> {
	await resetPostgresStorage();
	const storage = await PostgresStorage.open();
	try {
		await use(storage);
	} finally {
		await storage.close(context);
	}
}

registerStorageConformance({ describe, expect, it }, "PostgresStorage", withStorage);

describe("PostgresStorage exclusivity", () => {
	it("refuses a second concurrent open while the advisory lock is held", async () => {
		await resetPostgresStorage();
		const first = await PostgresStorage.open();
		try {
			await expect(PostgresStorage.open()).rejects.toThrow("advisory lock held");
		} finally {
			await first.close(context);
		}
		// The lock is released with the connection, so a later open succeeds.
		const reopened = await PostgresStorage.open();
		await reopened.close(context);
	});
});
