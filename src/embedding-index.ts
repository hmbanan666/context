import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { type Embedder, textChunks } from "./embedding-model.js";
import {
  type SearchTable,
  stemText,
  type VectorHit,
} from "./search-lexical.js";

const MAX_CHUNKS = 50_000;
// E5 gives unrelated text a high positive baseline; admit only stronger
// semantic evidence. Lexical hits never depend on this model-specific floor.
const MIN_COSINE = 0.8;
const LEASE_MS = 600_000;
export interface SemanticSelection {
  scope: string;
  question: string;
  from?: string | undefined;
  until?: string | undefined;
}
export interface SemanticHits {
  sources: VectorHit[];
  items: VectorHit[];
  reasons: string[];
}
export class EmbeddingIndex {
  readonly #db: DatabaseSync;
  readonly #embedder: Embedder;
  #tail: Promise<unknown> = Promise.resolve();
  #waiting = 0;
  #processing = false;
  #timer: NodeJS.Timeout | undefined;
  #active: Promise<unknown> | undefined;
  #stopping = false;

  constructor(path: string, embedder: Embedder) {
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    this.#db.function("source_timestamp", { deterministic: true }, (value) =>
      typeof value === "string" ? Date.parse(value) : null,
    );
    this.#db.function("context_stem", { deterministic: true }, (value) =>
      stemText(String(value)),
    );
    this.#embedder = embedder;
  }

  #embed(text: string, purpose: "query" | "passage") {
    if (this.#waiting >= 8 || this.#stopping)
      return Promise.reject(new Error("Embedding queue busy"));
    this.#waiting++;
    const work = this.#tail.then(async () => {
      const vector = await this.#embedder.embed(text, purpose);
      if (
        !vector.length ||
        vector.length > 4096 ||
        !vector.every(Number.isFinite)
      )
        throw new Error("Invalid embedding");
      const norm = Math.hypot(...vector);
      if (!norm) throw new Error("Invalid embedding norm");
      return vector.map((value) => value / norm);
    });
    this.#tail = work
      .catch(() => {})
      .finally(() => {
        this.#waiting--;
      });
    return work;
  }

  status(scope?: string) {
    const where = scope === undefined ? "" : " WHERE scope=?";
    const params = scope === undefined ? [] : [scope];
    const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
    for (const row of this.#db
      .prepare(
        `SELECT status,COUNT(*) n FROM embedding_jobs${where} GROUP BY status`,
      )
      .all(...params)) {
      const status = String(row.status) as keyof typeof counts;
      if (status in counts) counts[status] = Number(row.n);
    }
    const chunks = Number(
      this.#db
        .prepare(`SELECT COUNT(*) n FROM embedding_chunks${where}`)
        .get(...params)?.n,
    );
    return {
      ...counts,
      chunks,
      model: this.#embedder.version,
      maximumChunks: MAX_CHUNKS,
    };
  }

  backfill() {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["sources", "knowledge_items"] as const) {
        this.#db.exec(
          `INSERT OR IGNORE INTO embedding_jobs(kind,record_id,scope) SELECT '${table}',id,scope FROM ${table}`,
        );
      }
      // A successful same-version backfill is a no-op. Retry failures and stale
      // versions; live leases remain owned by the other worker/CLI process.
      this.#db
        .prepare(`UPDATE embedding_jobs SET status='queued',attempts=0,next_at=0,error=NULL
        WHERE status='failed' OR (status='completed' AND NOT EXISTS (
          SELECT 1 FROM embedding_chunks c WHERE c.kind=embedding_jobs.kind AND c.record_id=embedding_jobs.record_id AND c.model=?))`)
        .run(this.#embedder.version);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  rebuild() {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["sources", "knowledge_items"] as const) {
        this.#db.exec(`INSERT INTO ${table}_fts(${table}_fts) VALUES('rebuild');
          DELETE FROM ${table}_stemmed;
          INSERT INTO ${table}_stemmed(rowid,text) SELECT rowid,context_stem(text) FROM ${table};`);
      }
      this.#db.exec(`DELETE FROM embedding_chunks; DELETE FROM embedding_jobs;
        INSERT INTO embedding_jobs(kind,record_id,scope) SELECT 'sources',id,scope FROM sources;
        INSERT INTO embedding_jobs(kind,record_id,scope) SELECT 'knowledge_items',id,scope FROM knowledge_items;
        COMMIT`);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async processOne(): Promise<boolean> {
    if (this.#processing || this.#stopping) return false;
    this.#db
      .prepare(
        "UPDATE embedding_jobs SET status='failed',lease=NULL,error='lease_expired' WHERE status='running' AND next_at<=? AND attempts>=3",
      )
      .run(Date.now());
    const lease = randomUUID();
    const now = Date.now();
    const job = this.#db
      .prepare(`UPDATE embedding_jobs SET status='running',lease=?,next_at=?,attempts=attempts+1
      WHERE (kind,record_id)=(SELECT kind,record_id FROM embedding_jobs
      WHERE (status IN ('queued','failed') OR (status='running' AND next_at<=?)) AND next_at<=? AND attempts<3
      ORDER BY next_at,kind,record_id LIMIT 1) RETURNING *`)
      .get(lease, now + LEASE_MS, now, now);
    if (!job) return false;
    this.#processing = true;
    const table = String(job.kind) as SearchTable;
    try {
      if (table !== "sources" && table !== "knowledge_items")
        throw new Error("Invalid embedding job");
      const record = this.#db
        .prepare(`SELECT text FROM ${table} WHERE id=? AND scope=?`)
        .get(String(job.record_id), String(job.scope));
      if (!record) throw new Error("Missing embedding record");
      const chunks = textChunks(String(record.text));
      const vectors: Float32Array[] = [];
      for (const chunk of chunks) {
        vectors.push(await this.#embed(chunk.text, "passage"));
        this.#db
          .prepare("UPDATE embedding_jobs SET next_at=? WHERE lease=?")
          .run(Date.now() + LEASE_MS, lease);
        await yieldEventLoop();
      }
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        if (
          !this.#db
            .prepare("SELECT 1 FROM embedding_jobs WHERE lease=?")
            .get(lease)
        ) {
          this.#db.exec("ROLLBACK");
          return true;
        }
        this.#db
          .prepare("DELETE FROM embedding_chunks WHERE kind=? AND record_id=?")
          .run(table, String(job.record_id));
        const count = Number(
          this.#db.prepare("SELECT COUNT(*) n FROM embedding_chunks").get()?.n,
        );
        if (count + chunks.length > MAX_CHUNKS)
          throw new Error("Embedding capacity exceeded");
        for (const [i, chunk] of chunks.entries()) {
          const vector = vectors[i];
          if (!vector) throw new Error("Missing embedding");
          const blob = Buffer.alloc(vector.length * 4);
          vector.forEach((value, index) => {
            blob.writeFloatLE(value, index * 4);
          });
          this.#db
            .prepare(
              `INSERT INTO embedding_chunks(kind,record_id,scope,chunk,offset,model,vector) VALUES(?,?,?,?,?,?,?)`,
            )
            .run(
              table,
              String(job.record_id),
              String(job.scope),
              i,
              chunk.offset,
              this.#embedder.version,
              blob,
            );
        }
        this.#db
          .prepare(
            "UPDATE embedding_jobs SET status='completed',lease=NULL,next_at=0,error=NULL WHERE lease=?",
          )
          .run(lease);
        this.#db.exec("COMMIT");
      } catch (error) {
        if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
        throw error;
      }
    } catch {
      this.#db
        .prepare(
          "UPDATE embedding_jobs SET status='failed',lease=NULL,next_at=?,error='embedding_failed' WHERE lease=?",
        )
        .run(Date.now() + 60_000, lease);
    } finally {
      this.#processing = false;
    }
    return true;
  }

  start() {
    const tick = () => {
      if (this.#stopping) return;
      this.#active = this.processOne()
        .catch(() => false)
        .then((didWork) => {
          if (!this.#stopping)
            this.#timer = setTimeout(tick, didWork ? 10 : 1000).unref();
        });
    };
    // Warm the baked-in model in the background even when backfill is complete,
    // so the first question after a restart does not pay the load cost.
    this.#active = Promise.resolve()
      .then(() => this.#embedder.load?.())
      .catch(() => {})
      .then(() => {
        if (!this.#stopping) this.#timer = setTimeout(tick, 0).unref();
      });
  }

  async search(input: SemanticSelection): Promise<SemanticHits> {
    const empty: SemanticHits = { sources: [], items: [], reasons: [] };
    const status = this.status(input.scope);
    if (status.queued || status.running)
      empty.reasons.push("embeddings_pending");
    if (status.failed) empty.reasons.push("embeddings_unavailable");
    // Do not load the model when this authorized area has no vectors yet.
    if (
      !this.#db
        .prepare(
          "SELECT 1 FROM embedding_chunks WHERE scope=? AND model=? LIMIT 1",
        )
        .get(input.scope, this.#embedder.version)
    ) {
      return empty;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      const query = await Promise.race([
        this.#embed(input.question, "query"),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Embedding query timeout")),
            2000,
          );
        }),
      ]);
      const sources = await this.#nearest("sources", input, query);
      const items = await this.#nearest("knowledge_items", input, query);
      return {
        sources: sources.hits,
        items: items.hits,
        reasons: [
          ...new Set([...empty.reasons, ...sources.reasons, ...items.reasons]),
        ],
      };
    } catch {
      return { ...empty, reasons: ["embeddings_unavailable"] };
    } finally {
      clearTimeout(timeout);
    }
  }

  async #nearest(
    table: SearchTable,
    input: SemanticSelection,
    query: Float32Array,
  ) {
    const conditions = [
      "c.scope=?",
      "c.kind=?",
      "c.model=?",
      "r.scope=c.scope",
    ];
    const params: (string | number)[] = [
      input.scope,
      table,
      this.#embedder.version,
    ];
    if (table === "sources") {
      for (const [bound, op] of [
        [input.from, ">="],
        [input.until, "<"],
      ] as const)
        if (bound) {
          conditions.push(
            `source_timestamp(COALESCE(m.created_at,r.captured_at))${op}?`,
          );
          params.push(Date.parse(bound));
        }
    } else {
      conditions.push(
        "COALESCE((SELECT status FROM knowledge_reviews v WHERE v.knowledge_id=r.id AND v.scope=r.scope ORDER BY v.rowid DESC LIMIT 1),'suggested')<>'rejected'",
      );
      const invalid = ["s.id IS NULL"];
      for (const [bound, op] of [
        [input.from, "<"],
        [input.until, ">="],
      ] as const)
        if (bound) {
          invalid.push(
            `source_timestamp(COALESCE(m.created_at,s.captured_at))${op}?`,
          );
          params.push(Date.parse(bound));
        }
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM json_each(r.source_refs) ref LEFT JOIN sources s ON s.id=json_extract(ref.value,'$.sourceId') AND s.scope=r.scope LEFT JOIN source_metadata m ON m.source_id=s.id WHERE ${invalid.join(" OR ")})`,
      );
    }
    const from = `FROM embedding_chunks c JOIN ${table} r ON r.id=c.record_id ${table === "sources" ? "LEFT JOIN source_metadata m ON m.source_id=r.id" : ""} WHERE ${conditions.join(" AND ")}`;
    const top = new Map<
      string,
      { id: string; offset: number; score: number }
    >();
    let cursor = 0,
      scanned = 0;
    while (scanned < MAX_CHUNKS) {
      const rows = this.#db
        .prepare(
          `SELECT c.rowid,c.record_id,c.offset,c.vector ${from} AND c.rowid>? ORDER BY c.rowid LIMIT ?`,
        )
        .all(...params, cursor, Math.min(256, MAX_CHUNKS - scanned));
      if (!rows.length) break;
      for (const row of rows) {
        cursor = Number(row.rowid);
        scanned++;
        if (
          !(row.vector instanceof Uint8Array) ||
          row.vector.byteLength !== query.length * 4
        )
          continue;
        const blob = Buffer.from(row.vector);
        let score = 0;
        for (let i = 0; i < query.length; i++)
          score += (query[i] ?? 0) * blob.readFloatLE(i * 4);
        if (!Number.isFinite(score) || score < MIN_COSINE) continue;
        const id = String(row.record_id);
        if (score > (top.get(id)?.score ?? -Infinity))
          top.set(id, { id, offset: Number(row.offset), score });
        if (top.size > 101) {
          const last = [...top.values()]
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
            .at(-1);
          if (last) top.delete(last.id);
        }
      }
      await yieldEventLoop();
    }
    return {
      hits: [...top.values()]
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .map(({ id, offset }) => ({ id, offset })),
      reasons: scanned === MAX_CHUNKS ? ["vector_scan_limit"] : [],
    };
  }

  async close() {
    this.#stopping = true;
    clearTimeout(this.#timer);
    await this.#active;
    await this.#tail;
    await this.#embedder.close?.();
    this.#db.close();
  }
}
