/**
 * Postgres backend for the pi-durable `Storage` contract.
 *
 * This is a direct port of the framework's own `SqliteStorage` reference
 * implementation (`dist/storage/sqlite/storage.js`) onto Postgres, so the
 * semantics — global record IDs, commit sequences, fork-aware entry scans,
 * document incarnations and deltas — match the reference byte for byte. Only
 * the physical layer differs:
 *
 *   - one pinned connection behind a serial queue (the contract is a single
 *     writer; Postgres would allow more, the Session does not),
 *   - a session advisory lock so a second process cannot open the same database,
 *   - JSONB for document content, JSON text for the table records (Postgres
 *     rejects lone UTF-16 surrogates in JSONB, and the conformance suite
 *     deliberately stores them),
 *   - BIGINT for IDs and sequences, mapped back to JS numbers.
 */
import { apply, type Op } from "@earendil-works/chord/delta";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	StorageRequestError,
	type ConversationId,
	type ConversationQuery,
	type ConversationRecord,
	type Cursor,
	type DocumentAddress,
	type DocumentContent,
	type DocumentCreate,
	type DocumentId,
	type DocumentPoint,
	type DocumentQuery,
	type DocumentRecord,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type Id,
	type Page,
	type ScanOrder,
	type Seq,
	type Storage,
	type StorageWrite,
	type StoredDocument,
	type SubmissionId,
	type SubmissionQuery,
	type SubmissionRecord,
	type TaskId,
	type TaskQuery,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import pg from "pg";

// BIGINT arrives as a string by default; every ID and sequence here is small
// enough to be an exact JS number. The parser is set on this backend's own
// clients rather than globally: the product's pool (src/server/db.ts) keeps
// BIGINT in the string domain because its snowflake IDs exceed 2^53.
/** The storage lives in the product's Postgres unless the caller points it elsewhere. */
function defaultPgUrl(): string {
	return process.env.DURABLE_PG_URL ?? process.env.DATABASE_URL ?? "postgres://spike:spike@127.0.0.1:55432/paimeng_ts";
}

const bigintAsNumber = { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === 20 ? (value: string) => Number(value) : pg.types.getTypeParser(oid, format)) };

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

const ROOT_SCOPE_OWNER = 0;
/** Advisory-lock key held for the storage lifetime; any 64-bit constant works. */
const ADVISORY_LOCK_KEY = 0x64757261626c65n;

const idAt = (value: number): Id<string> => value as Id<string>;
const seqAt = (value: number): Seq => value as Seq;
const entryIdAt = (value: number): EntryId => value as EntryId;
const conversationIdAt = (value: number): ConversationId => value as ConversationId;
const taskIdAt = (value: number): TaskId => value as TaskId;
const documentIdAt = (value: number): DocumentId => value as DocumentId;

const parseRecord = <T>(value: string): T => JSON.parse(value) as T;
const encodeRecord = (value: unknown): string => JSON.stringify(value);

// Some SQLite bindings mangle lone surrogates; Postgres rejects them outright.
// JSON-encoding keeps indexed identities lossless (they match the SQLite backend).
const encodeIndexedString = (value: string): string => JSON.stringify(value);

/** Ordered scan position: the order plus the last ID a previous page returned. */
type ScanStart = { readonly order: ScanOrder; readonly after: number | undefined };

/** Resolve a scan's order and position; a cursor continues in its own order. */
function scanStart(requested: ScanOrder | undefined, cursor: Cursor | undefined, fallback: ScanOrder): ScanStart {
	if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
		throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
	}
	if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
	const { after, order: stored } = cursor as { after?: unknown; order?: unknown };
	if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new StorageRequestError("Invalid storage cursor");
	if (stored !== undefined && stored !== "ascending" && stored !== "descending") {
		throw new StorageRequestError("Invalid storage cursor");
	}
	const order = (stored ?? fallback) as ScanOrder;
	if (requested !== undefined && requested !== order) {
		throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
	}
	return { order, after };
}

const nextCursor = (id: number, order: ScanOrder): Cursor => ({ after: id, order });

const pageOf = <T extends { readonly id: number }>(values: readonly T[], limit: number, order: ScanOrder): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: nextCursor(items.at(-1)!.id, order) };
};

/** The ID condition, its parameter, and the `ORDER BY` direction of a table scan. */
const scanSql = (start: ScanStart): { clause: string; param: number; direction: "ASC" | "DESC" } =>
	start.order === "ascending"
		? { clause: "id > $1", param: start.after ?? -1, direction: "ASC" }
		: { clause: "id < $1", param: start.after ?? Number.MAX_SAFE_INTEGER, direction: "DESC" };

/** Indexed scope columns derived from a document scope. */
const scopeColumns = (scope: DocumentRecord["scope"]): { scopeKind: string; ownerId: number } => {
	switch (scope.kind) {
		case "session":
			return { scopeKind: "session", ownerId: ROOT_SCOPE_OWNER };
		case "conversation":
			return { scopeKind: "conversation", ownerId: scope.conversationId };
		case "task":
			return { scopeKind: "task", ownerId: scope.taskId };
	}
};

const addressParts = (address: DocumentAddress) => {
	const scope = scopeColumns(address.scope);
	return {
		kind: encodeIndexedString(address.kind),
		...scope,
		family: address.key === undefined ? 0 : 1,
		keyValue: encodeIndexedString(address.key ?? ""),
	};
};

const addressKey = (address: DocumentAddress): string => {
	const parts = addressParts(address);
	return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

const isCurrentOnly = (record: DocumentRecord): boolean => record.scope.kind !== "conversation" || record.history === "latest";

/** The record ID a write claims, if any. */
const writeId = (write: StorageWrite): number | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return write.value.id;
		case "document.create":
		case "document.copy":
			return write.record.id;
		case "document.change":
		case "document.retire":
			return undefined;
	}
};

/** Per-document intent collected from one commit batch before it is validated. */
type DocumentAction = {
	create?: DocumentCreate;
	content?: DocumentContent;
	copy?: { readonly id: DocumentId; readonly at: DocumentPoint };
	retire?: boolean;
};

const TABLE_NAMES = {
	durableSchema: "durable_schema",
	durableMetadata: "durable_metadata",
	recordIds: "record_ids",
	conversations: "conversations",
	entries: "entries",
	tasks: "tasks",
	submissions: "submissions",
	documents: "documents",
	documentRevisions: "document_revisions",
};

/**
 * Immutable ordered migration history. `durable_metadata` seeds `next_id` at 2
 * because ID 1 is reserved for the root conversation.
 */
const MIGRATIONS: readonly { version: number; statements: readonly string[] }[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE ${TABLE_NAMES.durableMetadata} (
				singleton smallint PRIMARY KEY CHECK (singleton = 1),
				next_id bigint NOT NULL,
				next_seq bigint NOT NULL
			)`,
			`INSERT INTO ${TABLE_NAMES.durableMetadata} (singleton, next_id, next_seq) VALUES (1, 2, 1)`,
			`CREATE TABLE ${TABLE_NAMES.recordIds} (
				id bigint PRIMARY KEY,
				record_type text NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
			)`,
			`CREATE TABLE ${TABLE_NAMES.conversations} (
				id bigint PRIMARY KEY,
				owner_conversation_id bigint,
				owner_task_id bigint,
				record text NOT NULL
			)`,
			`CREATE INDEX conversations_by_owner_conversation ON ${TABLE_NAMES.conversations} (owner_conversation_id, id)`,
			`CREATE INDEX conversations_by_owner_task ON ${TABLE_NAMES.conversations} (owner_task_id, id)`,
			`CREATE TABLE ${TABLE_NAMES.entries} (
				id bigint PRIMARY KEY,
				conversation_id bigint NOT NULL,
				head bigint,
				commit_seq bigint NOT NULL,
				record text NOT NULL
			)`,
			`CREATE INDEX entries_by_conversation ON ${TABLE_NAMES.entries} (conversation_id, id DESC)`,
			`CREATE INDEX entry_heads_by_conversation ON ${TABLE_NAMES.entries} (conversation_id, id DESC) WHERE head IS NOT NULL`,
			`CREATE TABLE ${TABLE_NAMES.tasks} (
				id bigint PRIMARY KEY,
				conversation_id bigint NOT NULL,
				kind text NOT NULL,
				status text NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
				abort_requested boolean NOT NULL,
				background boolean NOT NULL,
				record text NOT NULL
			)`,
			`CREATE INDEX tasks_by_status ON ${TABLE_NAMES.tasks} (status, id)`,
			`CREATE INDEX tasks_by_conversation ON ${TABLE_NAMES.tasks} (conversation_id, id)`,
			`CREATE INDEX tasks_by_kind ON ${TABLE_NAMES.tasks} (kind, id)`,
			`CREATE INDEX tasks_by_abort_requested ON ${TABLE_NAMES.tasks} (abort_requested, id)`,
			`CREATE INDEX tasks_by_background ON ${TABLE_NAMES.tasks} (background, id)`,
			`CREATE TABLE ${TABLE_NAMES.submissions} (
				id bigint PRIMARY KEY,
				conversation_id bigint NOT NULL,
				request_id text,
				status text NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
				record text NOT NULL
			)`,
			`CREATE INDEX submissions_by_request ON ${TABLE_NAMES.submissions} (conversation_id, request_id)`,
			`CREATE INDEX submissions_by_conversation ON ${TABLE_NAMES.submissions} (conversation_id, id)`,
			`CREATE INDEX submissions_by_status ON ${TABLE_NAMES.submissions} (status, id)`,
			`CREATE TABLE ${TABLE_NAMES.documents} (
				id bigint PRIMARY KEY,
				kind text NOT NULL,
				family smallint NOT NULL CHECK (family IN (0, 1)),
				key_value text NOT NULL,
				scope_kind text NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
				owner_id bigint NOT NULL,
				created_at bigint NOT NULL,
				retired_at bigint,
				record text NOT NULL,
				CONSTRAINT documents_unique_incarnation UNIQUE (id)
			)`,
			`CREATE INDEX documents_by_address ON ${TABLE_NAMES.documents}
				(kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
			`CREATE INDEX documents_by_scope ON ${TABLE_NAMES.documents} (scope_kind, owner_id, id)`,
			`CREATE INDEX documents_by_scope_kind ON ${TABLE_NAMES.documents} (scope_kind, owner_id, kind, id)`,
			`CREATE TABLE ${TABLE_NAMES.documentRevisions} (
				document_id bigint NOT NULL,
				seq bigint NOT NULL,
				kind text NOT NULL CHECK (kind IN ('base', 'delta')),
				version integer NOT NULL,
				content jsonb NOT NULL,
				PRIMARY KEY (document_id, seq)
			)`,
			`CREATE INDEX document_revisions_by_kind ON ${TABLE_NAMES.documentRevisions} (document_id, kind, seq DESC)`,
		],
	},
];

export type PostgresStorageOptions = {
	/** Connection string; defaults to the spike's local instance. */
	readonly connectionString?: string;
	/** Take the session advisory lock at open. Default true. */
	readonly lock?: boolean;
};

/**
 * Serial queue: the Session serializes commits itself, but reads and ID minting
 * arrive concurrently, and a single pinned connection cannot interleave.
 */
class SerialQueue {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export class PostgresStorage implements Storage {
	readonly #client: pg.Client;
	readonly #queue = new SerialQueue();
	#nextId: number;
	#closed = false;

	private constructor(client: pg.Client, nextId: number) {
		this.#client = client;
		this.#nextId = nextId;
	}

	/** Connect, migrate, take the exclusive lock, and read the ID counter. */
	static async open(options: PostgresStorageOptions = {}): Promise<PostgresStorage> {
		const client = new pg.Client({
			connectionString: options.connectionString ?? defaultPgUrl(),
			types: bigintAsNumber as never,
		});
		await client.connect();
		try {
			if (options.lock ?? true) {
				const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
					ADVISORY_LOCK_KEY.toString(),
				]);
				if (lock.rows[0]?.locked !== true) {
					throw new Error("Postgres storage is already open by another process (advisory lock held)");
				}
			}
			await applyMigrations(client);
			const metadata = await client.query<{ next_id: number }>(
				`SELECT next_id FROM ${TABLE_NAMES.durableMetadata} WHERE singleton = 1`,
			);
			const nextId = metadata.rows[0]?.next_id;
			if (nextId === undefined) throw new Error("Durable Postgres metadata is missing");
			return new PostgresStorage(client, nextId);
		} catch (error) {
			try {
				await client.end();
			} catch {
				// Preserve the initialization failure.
			}
			throw error;
		}
	}

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.#assertOpen();
		return this.#queue.run(() => this.#commit(writes));
	}

	async #commit(writes: readonly StorageWrite[]): Promise<Seq> {
		const documentActions = prepareDocumentActions(writes);
		const candidateNextId = this.#candidateNextId(writes);
		await this.#client.query("BEGIN");
		try {
			const metadata = await this.#client.query<{ next_id: number; next_seq: number }>(
				`SELECT next_id, next_seq FROM ${TABLE_NAMES.durableMetadata} WHERE singleton = 1 FOR UPDATE`,
			);
			const row = metadata.rows[0];
			if (row === undefined) throw new Error("Durable Postgres metadata is missing");
			const committedSeq = seqAt(row.next_seq);
			await this.#checkGlobalIds(writes);
			await this.#checkDocumentActions(documentActions);
			for (const write of writes) await this.#applyTableWrite(write, committedSeq);
			await this.#applyDocumentActions(documentActions, committedSeq);
			await this.#client.query(`UPDATE ${TABLE_NAMES.durableMetadata} SET next_id = $1, next_seq = $2 WHERE singleton = 1`, [
				String(Math.max(row.next_id, candidateNextId)),
				committedSeq + 1,
			]);
			await this.#client.query("COMMIT");
			this.#nextId = Math.max(this.#nextId, candidateNextId);
			return committedSeq;
		} catch (error) {
			try {
				await this.#client.query("ROLLBACK");
			} catch {
				// Preserve the original failure.
			}
			throw error;
		}
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.#assertOpen();
		return this.#queue.run(async () => {
			if (!Number.isSafeInteger(this.#nextId)) throw new Error("ID space is exhausted");
			return idAt(this.#nextId++) as I;
		});
	}

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.#assertOpen();
		return this.#queue.run(async () => {
			const row = await this.#client.query<{ record: string }>(
				`SELECT record FROM ${TABLE_NAMES.conversations} WHERE id = $1`,
				[id],
			);
			return row.rows[0] === undefined ? undefined : parseRecord<ConversationRecord>(row.rows[0].record);
		});
	}

	async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, _context: Context) {
		this.#assertOpen();
		return this.#queue.run(() => this.#scanConversations(query, limit, cursor));
	}

	async #scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined) {
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: unknown[] = [scan.param];
		if (query.ownerConversationId !== undefined) {
			params.push(query.ownerConversationId);
			clauses.push(`owner_conversation_id = $${params.length}`);
		}
		if (query.ownerTaskId !== undefined) {
			params.push(query.ownerTaskId);
			clauses.push(`owner_task_id = $${params.length}`);
		}
		params.push(limit + 1);
		const rows = await this.#client.query<{ record: string }>(
			`SELECT record FROM ${TABLE_NAMES.conversations} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT $${params.length}`,
			params,
		);
		return pageOf(rows.rows.map((row) => parseRecord<ConversationRecord>(row.record)), limit, start.order);
	}

	async entry(id: EntryId, context: Context): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>;
	async entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>;
	async entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined> {
		this.#assertOpen();
		return this.#queue.run(() => this.#readEntry(idOrConversationId, idOrContext, context));
	}

	async #readEntry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context: Context | undefined,
	): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined> {
		const id = context === undefined ? entryIdAt(idOrConversationId) : typeof idOrContext === "number" ? entryIdAt(idOrContext) : undefined;
		if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
		let conversation: ConversationRecord | undefined;
		if (context !== undefined) {
			const conversationId = conversationIdAt(idOrConversationId);
			conversation = await this.#readConversation(conversationId);
			if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		}
		const row = await this.#client.query<{ record: string; commit_seq: number }>(
			`SELECT record, commit_seq FROM ${TABLE_NAMES.entries} WHERE id = $1`,
			[id],
		);
		const first = row.rows[0];
		if (first === undefined) return undefined;
		const entry = parseRecord<EntryRecord>(first.record);
		if (conversation !== undefined) {
			let upperEntryId = Number.POSITIVE_INFINITY;
			while (conversation.id !== entry.conversationId) {
				if (conversation.parent === undefined) return undefined;
				upperEntryId = Math.min(upperEntryId, conversation.parent.at);
				const parent = await this.#readConversation(conversation.parent.conversationId);
				if (parent === undefined) return undefined;
				conversation = parent;
			}
			if (entry.id > upperEntryId) return undefined;
		}
		return { entry, commitSeq: seqAt(first.commit_seq) };
	}

	async findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, _context: Context) {
		this.#assertOpen();
		return this.#queue.run(() => this.#readLatestHeadMarker(conversationId, atOrBeforeEntryId));
	}

	async #readLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined) {
		let conversation = await this.#readConversation(conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
			const rows =
				upper === undefined
					? await this.#client.query<{ record: string }>(
							`SELECT record FROM ${TABLE_NAMES.entries} WHERE conversation_id = $1 AND head IS NOT NULL ORDER BY id DESC LIMIT 1`,
							[conversation.id],
						)
					: await this.#client.query<{ record: string }>(
							`SELECT record FROM ${TABLE_NAMES.entries} WHERE conversation_id = $1 AND head IS NOT NULL AND id <= $2 ORDER BY id DESC LIMIT 1`,
							[conversation.id, upper],
						);
			const row = rows.rows[0];
			if (row !== undefined) return parseRecord<EntryRecord & { head: EntryId }>(row.record);
			if (conversation.parent === undefined) return undefined;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			const parent = await this.#readConversation(conversation.parent.conversationId);
			if (parent === undefined) return undefined;
			conversation = parent;
		}
	}

	async scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, _context: Context) {
		this.#assertOpen();
		return this.#queue.run(() => this.#readEntries(query, limit, cursor));
	}

	async #readEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined) {
		const { order, after } = scanStart(query.order, cursor, "descending");
		if (order === "ascending") return this.#readEntriesAscending(query, limit, after);
		let conversation = await this.#readConversation(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		const values: EntryRecord[] = [];
		while (true) {
			const clauses = ["conversation_id = $1"];
			const params: unknown[] = [conversation.id];
			if (query.minEntryId !== undefined) {
				params.push(query.minEntryId);
				clauses.push(`id >= $${params.length}`);
			}
			if (upper !== undefined) {
				params.push(upper);
				clauses.push(`id <= $${params.length}`);
			}
			params.push(limit + 1 - values.length);
			const rows = await this.#client.query<{ record: string }>(
				`SELECT record FROM ${TABLE_NAMES.entries} WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT $${params.length}`,
				params,
			);
			values.push(...rows.rows.map((row) => parseRecord<EntryRecord>(row.record)));
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			const parent = await this.#readConversation(conversation.parent.conversationId);
			if (parent === undefined) break;
			conversation = parent;
		}
		return pageOf(values, limit, "descending");
	}

	/** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
	async #readEntriesAscending(query: EntryQuery, limit: number, after: number | undefined) {
		const segments: { conversationId: number; upper: number | undefined }[] = [];
		let conversation = await this.#readConversation(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper: number | undefined = query.maxEntryId;
		while (true) {
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			const parent = await this.#readConversation(conversation.parent.conversationId);
			if (parent === undefined) break;
			conversation = parent;
		}
		let lower: number | undefined = query.minEntryId;
		if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
		const values: EntryRecord[] = [];
		for (const segment of segments.reverse()) {
			const clauses = ["conversation_id = $1"];
			const params: unknown[] = [segment.conversationId];
			if (lower !== undefined) {
				params.push(lower);
				clauses.push(`id >= $${params.length}`);
			}
			if (segment.upper !== undefined) {
				params.push(segment.upper);
				clauses.push(`id <= $${params.length}`);
			}
			params.push(limit + 1 - values.length);
			const rows = await this.#client.query<{ record: string }>(
				`SELECT record FROM ${TABLE_NAMES.entries} WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT $${params.length}`,
				params,
			);
			values.push(...rows.rows.map((row) => parseRecord<EntryRecord>(row.record)));
			if (values.length > limit) break;
		}
		return pageOf(values, limit, "ascending");
	}

	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.#assertOpen();
		return this.#queue.run(async () => {
			const row = await this.#client.query<{ record: string }>(
				`SELECT record FROM ${TABLE_NAMES.tasks} WHERE id = $1`,
				[id],
			);
			return row.rows[0] === undefined ? undefined : parseRecord<StoredTask>(row.rows[0].record);
		});
	}

	async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, _context: Context) {
		this.#assertOpen();
		return this.#queue.run(async () => {
			const start = scanStart(query.order, cursor, "ascending");
			const scan = scanSql(start);
			const clauses = [scan.clause];
			const params: unknown[] = [scan.param];
			if (query.conversationId !== undefined) {
				params.push(query.conversationId);
				clauses.push(`conversation_id = $${params.length}`);
			}
			if (query.kind !== undefined) {
				params.push(encodeIndexedString(query.kind));
				clauses.push(`kind = $${params.length}`);
			}
			if (query.status !== undefined) {
				params.push(query.status);
				clauses.push(`status = $${params.length}`);
			}
			if (query.abortRequested !== undefined) {
				params.push(query.abortRequested);
				clauses.push(`abort_requested = $${params.length}`);
			}
			if (query.background !== undefined) {
				params.push(query.background);
				clauses.push(`background = $${params.length}`);
			}
			params.push(limit + 1);
			const rows = await this.#client.query<{ record: string }>(
				`SELECT record FROM ${TABLE_NAMES.tasks} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT $${params.length}`,
				params,
			);
			return pageOf(rows.rows.map((row) => parseRecord<StoredTask>(row.record)), limit, start.order);
		});
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.#assertOpen();
		return this.#queue.run(async () => {
			const row = await this.#client.query<{ record: string }>(
				`SELECT record FROM ${TABLE_NAMES.submissions} WHERE id = $1`,
				[id],
			);
			return row.rows[0] === undefined ? undefined : parseRecord<SubmissionRecord>(row.rows[0].record);
		});
	}

	async scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, _context: Context) {
		this.#assertOpen();
		return this.#queue.run(async () => {
			const start = scanStart(query.order, cursor, "ascending");
			const scan = scanSql(start);
			const clauses = [scan.clause];
			const params: unknown[] = [scan.param];
			if (query.conversationId !== undefined) {
				params.push(query.conversationId);
				clauses.push(`conversation_id = $${params.length}`);
			}
			if (query.status !== undefined) {
				params.push(query.status);
				clauses.push(`status = $${params.length}`);
			}
			params.push(limit + 1);
			const rows = await this.#client.query<{ record: string }>(
				`SELECT record FROM ${TABLE_NAMES.submissions} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT $${params.length}`,
				params,
			);
			return pageOf(rows.rows.map((row) => parseRecord<SubmissionRecord>(row.record)), limit, start.order);
		});
	}

	async submissionByRequest(conversationId: ConversationId, requestId: string, _context: Context): Promise<SubmissionRecord | undefined> {
		this.#assertOpen();
		return this.#queue.run(async () => {
			const row = await this.#client.query<{ record: string }>(
				`SELECT record FROM ${TABLE_NAMES.submissions} WHERE conversation_id = $1 AND request_id = $2`,
				[conversationId, encodeIndexedString(requestId)],
			);
			return row.rows[0] === undefined ? undefined : parseRecord<SubmissionRecord>(row.rows[0].record);
		});
	}

	async findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
		this.#assertOpen();
		return this.#queue.run(async () => {
			const parts = addressParts(address);
			const base = `SELECT record FROM ${TABLE_NAMES.documents}
				WHERE kind = $1 AND scope_kind = $2 AND owner_id = $3 AND family = $4 AND key_value = $5`;
			const params: unknown[] = [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
			const sql =
				at === "current"
					? `${base} AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
					: `${base} AND created_at <= $6 AND (retired_at IS NULL OR retired_at > $6) ORDER BY created_at DESC LIMIT 1`;
			if (at !== "current") params.push(at);
			const row = await this.#client.query<{ record: string }>(sql, params);
			return row.rows[0] === undefined ? undefined : parseRecord<DocumentRecord>(row.rows[0].record);
		});
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.#assertOpen();
		return this.#queue.run(() => this.#materializeDocument(id, at));
	}

	async scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, _context: Context) {
		this.#assertOpen();
		return this.#queue.run(async () => {
			const scope = scopeColumns(query.scope);
			const clauses = ["scope_kind = $1", "owner_id = $2", "id > $3"];
			const params: unknown[] = [scope.scopeKind, scope.ownerId, cursorAfter(cursor) ?? -1];
			if (query.kind !== undefined) {
				params.push(encodeIndexedString(query.kind));
				clauses.push(`kind = $${params.length}`);
			}
			if (query.at === "current") {
				clauses.push("retired_at IS NULL");
			} else {
				params.push(query.at);
				clauses.push(`created_at <= $${params.length}`);
				params.push(query.at);
				clauses.push(`(retired_at IS NULL OR retired_at > $${params.length})`);
			}
			params.push(limit + 1);
			const rows = await this.#client.query<{ record: string }>(
				`SELECT record FROM ${TABLE_NAMES.documents} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${params.length}`,
				params,
			);
			return pageOf(rows.rows.map((row) => parseRecord<DocumentRecord>(row.record)), limit, "ascending");
		});
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#queue.run(async () => {
			// `client.end()` releases the session advisory lock.
			await this.#client.end();
		});
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("PostgresStorage is closed");
	}

	async #readConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
		const row = await this.#client.query<{ record: string }>(
			`SELECT record FROM ${TABLE_NAMES.conversations} WHERE id = $1`,
			[id],
		);
		return row.rows[0] === undefined ? undefined : parseRecord<ConversationRecord>(row.rows[0].record);
	}

	async #materializeDocument(id: DocumentId, at: DocumentPoint): Promise<StoredDocument | undefined> {
		const row = await this.#client.query<{ record: string }>(
			`SELECT record FROM ${TABLE_NAMES.documents} WHERE id = $1`,
			[id],
		);
		const stored = row.rows[0];
		if (stored === undefined) return undefined;
		const record = parseRecord<DocumentRecord>(stored.record);
		if (at !== "current" && isCurrentOnly(record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const base = await this.#client.query<{ seq: number; version: number; content: JsonValue }>(
			`SELECT seq, version, content FROM ${TABLE_NAMES.documentRevisions}
				WHERE document_id = $1 AND kind = 'base' AND seq <= $2 ORDER BY seq DESC LIMIT 1`,
			[id, upper],
		);
		const baseRow = base.rows[0];
		if (baseRow === undefined) throw new Error(`Document ${id} is missing a required base`);
		let value = structuredClone(baseRow.content) as JsonValue;
		const tail = await this.#client.query<{ version: number; content: JsonValue }>(
			`SELECT version, content FROM ${TABLE_NAMES.documentRevisions}
				WHERE document_id = $1 AND kind = 'delta' AND seq > $2 AND seq <= $3 ORDER BY seq`,
			[id, baseRow.seq, upper],
		);
		for (const revision of tail.rows) {
			if (revision.version !== baseRow.version) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			value = apply(value, revision.content as unknown as readonly Op[]);
		}
		return { record, version: baseRow.version, value: value as StoredDocument["value"], deltasSinceBase: tail.rows.length };
	}

	#candidateNextId(writes: readonly StorageWrite[]): number {
		let nextId = this.#nextId;
		for (const write of writes) {
			const id = writeId(write);
			if (id !== undefined) nextId = Math.max(nextId, id + 1);
		}
		return nextId;
	}

	async #checkGlobalIds(writes: readonly StorageWrite[]): Promise<void> {
		const claimed = new Map<number, string>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			const existingRow = await this.#client.query<{ record_type: string }>(
				`SELECT record_type FROM ${TABLE_NAMES.recordIds} WHERE id = $1`,
				[id],
			);
			const existing = existingRow.rows[0]?.record_type;
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	async #checkDocumentActions(actions: ReadonlyMap<number, DocumentAction>): Promise<void> {
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			}
			const row = await this.#client.query<{ record: string }>(
				`SELECT record FROM ${TABLE_NAMES.documents} WHERE id = $1`,
				[id],
			);
			const existingRow = row.rows[0];
			const existing = existingRow === undefined ? undefined : parseRecord<DocumentRecord>(existingRow.record);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = await this.#client.query<{ version: number }>(
					`SELECT version FROM ${TABLE_NAMES.documentRevisions} WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
					[id],
				);
				const previousRow = previous.rows[0];
				if (previousRow === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previousRow.version !== action.content.version) throw new Error(`Document ${id} version transition requires a base`);
			}
			const record = action.create ?? existing!;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			if (live === undefined) live = (await this.#currentDocumentId(record)) === undefined ? 0 : 1;
			if (action.retire && existing !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
	}

	async #currentDocumentId(address: DocumentAddress): Promise<DocumentId | undefined> {
		const parts = addressParts(address);
		const row = await this.#client.query<{ id: number }>(
			`SELECT id FROM ${TABLE_NAMES.documents}
				WHERE kind = $1 AND scope_kind = $2 AND owner_id = $3 AND family = $4 AND key_value = $5 AND retired_at IS NULL
				LIMIT 1`,
			[parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue],
		);
		return row.rows[0] === undefined ? undefined : documentIdAt(row.rows[0].id);
	}

	async #applyTableWrite(write: StorageWrite, seq: Seq): Promise<void> {
		switch (write.type) {
			case "conversation":
				await this.#claimId(write.value.id, "conversation");
				await this.#client.query(
					`INSERT INTO ${TABLE_NAMES.conversations} (id, owner_conversation_id, owner_task_id, record) VALUES ($1, $2, $3, $4)`,
					[write.value.id, write.value.owner?.conversationId ?? null, write.value.owner?.taskId ?? null, encodeRecord(write.value)],
				);
				break;
			case "entry":
				await this.#claimId(write.value.id, "entry");
				await this.#client.query(
					`INSERT INTO ${TABLE_NAMES.entries} (id, conversation_id, head, commit_seq, record) VALUES ($1, $2, $3, $4, $5)`,
					[write.value.id, write.value.conversationId, write.value.head ?? null, seq, encodeRecord(write.value)],
				);
				break;
			case "task":
				await this.#claimId(write.value.id, "task");
				await this.#client.query(
					`INSERT INTO ${TABLE_NAMES.tasks} (id, conversation_id, kind, status, abort_requested, background, record)
						VALUES ($1, $2, $3, $4, $5, $6, $7)
						ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
						status = excluded.status, abort_requested = excluded.abort_requested,
						background = excluded.background, record = excluded.record`,
					[
						write.value.id,
						write.value.conversationId,
						encodeIndexedString(write.value.kind),
						write.value.state.status,
						write.value.abortRequested,
						write.value.background,
						encodeRecord(write.value),
					],
				);
				break;
			case "submission":
				await this.#claimId(write.value.id, "submission");
				await this.#client.query(
					`INSERT INTO ${TABLE_NAMES.submissions} (id, conversation_id, request_id, status, record) VALUES ($1, $2, $3, $4, $5)
						ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id,
						request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
					[
						write.value.id,
						write.value.conversationId,
						write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId),
						write.value.status,
						encodeRecord(write.value),
					],
				);
				break;
			case "document.create":
			case "document.copy":
			case "document.change":
			case "document.retire":
				break;
		}
	}

	async #claimId(id: number, table: string): Promise<void> {
		await this.#client.query(
			`INSERT INTO ${TABLE_NAMES.recordIds} (id, record_type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
			[id, table],
		);
	}

	async #applyDocumentActions(actions: ReadonlyMap<number, DocumentAction>, seq: Seq): Promise<void> {
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				try {
					const stored = await this.#materializeDocument(action.copy.id, action.copy.at);
					if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
					const create = action.create!;
					if (
						stored.record.scope.kind !== "conversation" ||
						create.scope.kind !== "conversation" ||
						stored.record.kind !== create.kind ||
						stored.record.key !== create.key ||
						stored.record.history !== create.history ||
						stored.record.fork !== create.fork
					) {
						throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
					}
					content = { kind: "base", version: stored.version, value: stored.value };
				} catch (error) {
					throw new Error(`Document copy ${id} was rejected`, { cause: error });
				}
			}
			let record: DocumentRecord;
			if (action.create !== undefined) {
				record = {
					...action.create,
					createdAt: seq,
					...(action.retire ? { retiredAt: seq } : {}),
				};
				const parts = addressParts(record);
				await this.#claimId(id, "document");
				await this.#client.query(
					`INSERT INTO ${TABLE_NAMES.documents}
						(id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
						VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
					[
						id,
						parts.kind,
						parts.family,
						parts.keyValue,
						parts.scopeKind,
						parts.ownerId,
						seq,
						action.retire ? seq : null,
						encodeRecord(record),
					],
				);
			} else {
				const row = await this.#client.query<{ record: string }>(
					`SELECT record FROM ${TABLE_NAMES.documents} WHERE id = $1`,
					[id],
				);
				record = parseRecord<DocumentRecord>(row.rows[0]!.record);
			}
			if (content !== undefined) {
				if (content.kind === "base" && isCurrentOnly(record)) {
					await this.#client.query(`DELETE FROM ${TABLE_NAMES.documentRevisions} WHERE document_id = $1`, [id]);
				}
				const encoded = content.kind === "base" ? encodeRecord(content.value) : encodeRecord(content.ops);
				await this.#client.query(
					`INSERT INTO ${TABLE_NAMES.documentRevisions} (document_id, seq, kind, version, content) VALUES ($1, $2, $3, $4, $5)`,
					[id, seq, content.kind, content.version, encoded],
				);
			}
			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq };
					await this.#client.query(`UPDATE ${TABLE_NAMES.documents} SET retired_at = $1, record = $2 WHERE id = $3`, [
						seq,
						encodeRecord(record),
						id,
					]);
				}
				if (isCurrentOnly(record)) {
					await this.#client.query(`DELETE FROM ${TABLE_NAMES.documentRevisions} WHERE document_id = $1`, [id]);
				}
			}
		}
	}
}

const cursorAfter = (cursor: Cursor | undefined): number | undefined => {
	const after = (cursor as { after?: unknown } | undefined)?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new StorageRequestError("Invalid storage cursor");
	return after;
};

/** Collect per-document intents, rejecting a batch that commands one document twice. */
function prepareDocumentActions(writes: readonly StorageWrite[]): Map<number, DocumentAction> {
	const actions = new Map<number, DocumentAction>();
	for (const write of writes) {
		if (write.type !== "document.create" && write.type !== "document.copy" && write.type !== "document.change" && write.type !== "document.retire") {
			continue;
		}
		const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
		let action = actions.get(id);
		if (action === undefined) {
			action = {};
			actions.set(id, action);
		}
		switch (write.type) {
			case "document.create":
				if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
					throw new Error(`Document ${id} has more than one content command`);
				}
				action.create = write.record;
				action.content = write.content;
				break;
			case "document.copy":
				if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
					throw new Error(`Document ${id} has more than one content command`);
				}
				action.create = write.record;
				action.copy = write.source;
				break;
			case "document.change":
				if (action.content !== undefined || action.copy !== undefined) {
					throw new Error(`Document ${id} has more than one content command`);
				}
				action.content = write.content;
				break;
			case "document.retire":
				if (action.retire) throw new Error(`Document ${id} is retired more than once`);
				action.retire = true;
				break;
		}
	}
	return actions;
}

/** Apply every pending migration under a version gate. */
async function applyMigrations(client: pg.Client): Promise<void> {
	await client.query("BEGIN");
	try {
		await client.query(`CREATE TABLE IF NOT EXISTS ${TABLE_NAMES.durableSchema} (
			singleton smallint PRIMARY KEY CHECK (singleton = 1),
			version integer NOT NULL CHECK (version >= 0)
		)`);
		await client.query(`INSERT INTO ${TABLE_NAMES.durableSchema} (singleton, version) VALUES (1, 0) ON CONFLICT (singleton) DO NOTHING`);
		const row = await client.query<{ version: number }>(`SELECT version FROM ${TABLE_NAMES.durableSchema} WHERE singleton = 1`);
		const currentVersion = MIGRATIONS.at(-1)?.version ?? 0;
		const version = row.rows[0]?.version;
		if (version === undefined) throw new Error("Durable Postgres schema metadata is missing");
		if (version > currentVersion) throw new Error(`Durable Postgres schema version ${version} is newer than supported ${currentVersion}`);
		for (const migration of MIGRATIONS) {
			if (migration.version <= version) continue;
			for (const statement of migration.statements) await client.query(statement);
			await client.query(`UPDATE ${TABLE_NAMES.durableSchema} SET version = $1 WHERE singleton = 1`, [migration.version]);
		}
		await client.query("COMMIT");
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch {
			// Preserve the original failure.
		}
		throw error;
	}
}

/** Drop and recreate the whole durable schema; used to reset a spike database between runs. */
export async function resetPostgresStorage(options: PostgresStorageOptions = {}): Promise<void> {
	const client = new pg.Client({
		connectionString: options.connectionString ?? defaultPgUrl(),
		types: bigintAsNumber as never,
	});
	await client.connect();
	try {
		await client.query(`DROP TABLE IF EXISTS ${TABLE_NAMES.documentRevisions}, ${TABLE_NAMES.documents}, ${TABLE_NAMES.submissions}, ${TABLE_NAMES.tasks}, ${TABLE_NAMES.entries}, ${TABLE_NAMES.conversations}, ${TABLE_NAMES.recordIds}, ${TABLE_NAMES.durableMetadata}, ${TABLE_NAMES.durableSchema} CASCADE`);
	} finally {
		await client.end();
	}
}


