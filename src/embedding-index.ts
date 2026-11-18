import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { type Embedder, textChunks } from "./embedding-model.js";
import { knowledgeWindowSql } from "./journal.js";
import { linkedProjectSql } from "./projects.js";
import { retirementFilter } from "./retirement.js";
import { latestReviewStatusSql } from "./review-status.js";
import { questionTerms } from "./package-query.js";
import { addPhase, type SearchPhases } from "./search-timing.js";
import {
  ensureVisibleSourceIndex,
  registerSearchFunctions,
  stemText,
  type SearchTable,
  type VectorHit,
} from "./search-lexical.js";
import { visibleSourceText } from "./source-text.js";

const MAX_CHUNKS = 50_000;
// One ASCII probe does not initialize the Cyrillic tokenizer or a longer
// ONNX input. The first Russian question then misses the two-second query
// budget. Both probes run before embeddings_ready.
const warmupProbes = [
  "How does the bot's memory work?",
  "Как устроена память бота?",
];

function warmQueryPath(): void {
  for (const text of warmupProbes) {
    for (const term of questionTerms(text)) stemText(term);
  }
}
// Calibrated on the private RU/EN corpus (see docs/search.md).
// Lexical hits never depend on these model-specific bounds.
// Candidate floor only. Answer grounding uses the higher thresholds in grounding.ts.
const MIN_COSINE = 0.8;
const MAX_VECTOR_CANDIDATES = 20;
const LEASE_MS = 600_000;
export interface SemanticSelection {
  scope: string;
  question: string;
  from?: string | undefined;
  until?: string | undefined;
  projectId?: string | undefined;
}
export interface StoredChunkRef {
  readonly kind: "sources" | "knowledge_items";
  readonly id: string;
}

/** Startup model state. `off` until warmup runs, and again if the model is missing. */
export type EmbeddingWarmup = "off" | "warming" | "ready";

export interface SemanticHits {
  available: boolean;
  sources: VectorHit[];
  items: VectorHit[];
  reasons: string[];
  /** Cosine of the query to the cached area or project centroid. */
  background?: number;
  /**
   * Query cosine against stored chunk vectors, including scores below the
   * 0.80 retrieval floor. Grounding uses this so a rare-term passage is not
   * scored as cosine 0 just because it missed the candidate list. Absent
   * when no query vector was embedded.
   */
  storedCosines?: (records: readonly StoredChunkRef[]) => VectorHit[];
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
  #warmup: EmbeddingWarmup = "off";
  #warmStarted = false;
  #warmTask: Promise<void> = Promise.resolve();
  // Centroid of the passage vectors for one area or project. The stamp is the
  // chunk count and max rowid, so a rewrite recomputes it.
  #centroids = new Map<
    string,
    { stamp: string; vector: Float32Array | null }
  >();

  constructor(
    path: string,
    embedder: Embedder,
    options: { readOnly?: boolean } = {},
  ) {
    this.#db = new DatabaseSync(path, {
      timeout: 5000,
      readOnly: options.readOnly ?? false,
    });
    this.#db.function("source_timestamp", { deterministic: true }, (value) =>
      typeof value === "string" ? Date.parse(value) : null,
    );
    registerSearchFunctions(this.#db);
    this.#embedder = embedder;
  }

  get model() {
    return this.#embedder.version;
  }

  hasVectors(scope?: string) {
    return !!this.#db
      .prepare(
        `SELECT 1 FROM embedding_chunks WHERE model=?${scope === undefined ? "" : " AND scope=?"} LIMIT 1`,
      )
      .get(this.model, ...(scope === undefined ? [] : [scope]));
  }

  async load() {
    await this.#embedder.load?.();
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

  otherModels(scope?: string): string[] {
    return (
      this.#db
        .prepare(
          `SELECT DISTINCT model FROM embedding_chunks WHERE model <> ?${scope === undefined ? "" : " AND scope = ?"} ORDER BY model`,
        )
        .all(
          this.#embedder.version,
          ...(scope === undefined ? [] : [scope]),
        ) as { model: string }[]
    ).map((row) => String(row.model));
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
      otherModels: this.otherModels(scope),
      maximumChunks: MAX_CHUNKS,
    };
  }

  // Resumable. Completed rows that already have this model id are left in
  // place. A failed row is retried immediately, up to the existing three
  // attempts. Safe to call again.
  async reindexEmbeddings(
    batch: number,
    onProgress: (status: ReturnType<EmbeddingIndex["status"]>) => void,
  ) {
    if (!Number.isInteger(batch) || batch < 1 || batch > 64)
      throw new Error("Invalid reindex batch");
    this.backfill();
    onProgress(this.status());
    let finished = 0;
    let releases = 0;
    for (;;) {
      const did = await this.processOne();
      if (did) {
        finished++;
        if (finished % batch === 0) onProgress(this.status());
        continue;
      }
      if (releases >= 3) break;
      const released = this.#db
        .prepare(
          `UPDATE embedding_jobs SET status = 'queued', next_at = 0
           WHERE status = 'failed' AND attempts < 3`,
        )
        .run().changes;
      if (!released) break;
      releases++;
    }
    const status = this.status();
    onProgress(status);
    return status;
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
    ensureVisibleSourceIndex(this.#db);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .exec(`INSERT INTO knowledge_items_fts(knowledge_items_fts) VALUES('rebuild');
        DELETE FROM knowledge_items_stemmed;
        INSERT INTO knowledge_items_stemmed(rowid,text) SELECT rowid,context_stem(text) FROM knowledge_items;
        DELETE FROM sources_fts;
        INSERT INTO sources_fts(rowid, text)
          SELECT rowid, context_visible_text(text) FROM sources;
        DELETE FROM sources_stemmed;
        INSERT INTO sources_stemmed(rowid,text)
          SELECT rowid, context_stem(context_visible_text(text)) FROM sources;`);
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
      const raw = String(record.text);
      const chunks = textChunks(
        table === "sources" ? visibleSourceText(raw) : raw,
      );
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

  get warmup(): EmbeddingWarmup {
    return this.#warmup;
  }

  /**
   * Load the model and embed one dummy query. The server calls this after
   * listen so the first search does not pay startup cost and the listening
   * line is not delayed. Success is one stderr JSON line. A missing model
   * leaves the state `off`; the embedder already logs `embeddings_unavailable`.
   */
  warm(): void {
    if (this.#warmStarted || this.#stopping) return;
    this.#warmStarted = true;
    this.#warmup = "warming";
    this.#warmTask = (async () => {
      try {
        warmQueryPath();
        await this.#embedder.load?.();
        if (this.#stopping) return;
        for (const text of warmupProbes) {
          if (this.#stopping) return;
          await this.#embed(text, "query");
        }
        if (this.#stopping) return;
        this.#warmup = "ready";
        console.error(JSON.stringify({ event: "embeddings_ready" }));
      } catch {
        if (this.#warmup !== "ready") this.#warmup = "off";
      }
    })();
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
    if (!this.#stopping) this.#timer = setTimeout(tick, 0).unref();
  }

  async search(
    input: SemanticSelection,
    phases?: SearchPhases,
  ): Promise<SemanticHits> {
    const empty: SemanticHits = {
      sources: [],
      items: [],
      reasons: [],
      available: false,
    };
    const status = this.status(input.scope);
    if (status.queued || status.running)
      empty.reasons.push("embeddings_pending");
    if (status.failed) empty.reasons.push("embeddings_unavailable");
    // Vectors from another model id are visible but never scored.
    if (status.otherModels.length) empty.reasons.push("embeddings_mixed");
    // Do not load the model when this authorized area has no current vectors.
    if (!this.hasVectors(input.scope)) return empty;
    let timeout: NodeJS.Timeout | undefined;
    const embedStarted = performance.now();
    let embedded = false;
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
      embedded = true;
      addPhase(phases, "embedMs", embedStarted);
      const groundStarted = performance.now();
      const background = await this.#backgroundCosine(input, query);
      addPhase(phases, "groundingMs", groundStarted);
      const retrievalStarted = performance.now();
      const sources = await this.#nearest("sources", input, query);
      const items = await this.#nearest("knowledge_items", input, query);
      addPhase(phases, "retrievalMs", retrievalStarted);
      return {
        available: true,
        background,
        sources: sources.hits,
        items: items.hits,
        reasons: [
          ...new Set([...empty.reasons, ...sources.reasons, ...items.reasons]),
        ],
        storedCosines: (records) =>
          this.#storedCosines(input.scope, query, records),
      };
    } catch {
      if (!embedded) addPhase(phases, "embedMs", embedStarted);
      return { ...empty, reasons: ["embeddings_unavailable"] };
    } finally {
      clearTimeout(timeout);
    }
  }

  // Same rows nearest will score. Sources and knowledge use different filters.
  #chunkFrom(table: SearchTable, input: SemanticSelection) {
    // c.model is the stored embedder id. A different id never enters the cosine.
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
      conditions.push(retirementFilter(this.#db, "r.id"));
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
        `${latestReviewStatusSql("r.id", "r.scope", "suggested")}<>'rejected'`,
      );
      // Area-wide retrieval still omits distilled sentences and journals.
      if (!input.projectId)
        conditions.push("r.kind NOT IN ('fact', 'decision', 'journal')");
      const window = knowledgeWindowSql(this.#db, "r", input.from, input.until);
      conditions.push(window.sql);
      params.push(...window.params);
    }
    if (input.projectId) {
      conditions.push(
        linkedProjectSql(table === "sources" ? "source" : "knowledge", "r.id"),
      );
      params.push(input.projectId);
    }
    const from = `FROM embedding_chunks c JOIN ${table} r ON r.id=c.record_id ${table === "sources" ? "LEFT JOIN source_metadata m ON m.source_id=r.id" : ""} WHERE ${conditions.join(" AND ")}`;
    return { from, params };
  }

  async #backgroundCosine(
    input: SemanticSelection,
    query: Float32Array,
  ): Promise<number> {
    const vector = await this.#centroid(input);
    if (!vector || vector.length !== query.length) return 0;
    let score = 0;
    for (let i = 0; i < query.length; i++)
      score += (query[i] ?? 0) * (vector[i] ?? 0);
    return Number.isFinite(score) ? score : 0;
  }

  async #centroid(input: SemanticSelection): Promise<Float32Array | null> {
    const key = [
      this.#embedder.version,
      input.scope,
      input.projectId ?? "",
      input.from ?? "",
      input.until ?? "",
    ].join("\0");
    const pools = [
      this.#chunkFrom("sources", input),
      this.#chunkFrom("knowledge_items", input),
    ];
    const stamp = pools
      .map((pool) => {
        const row = this.#db
          .prepare(
            `SELECT COUNT(*) n, COALESCE(MAX(c.rowid), 0) hi ${pool.from}`,
          )
          .get(...pool.params) as { n?: number; hi?: number } | undefined;
        return `${Number(row?.n ?? 0)}:${Number(row?.hi ?? 0)}`;
      })
      .join("|");
    const cached = this.#centroids.get(key);
    if (cached?.stamp === stamp) return cached.vector;
    let sum: Float64Array | undefined;
    let count = 0;
    let scanned = 0;
    for (const pool of pools) {
      let cursor = 0;
      while (scanned < MAX_CHUNKS) {
        const rows = this.#db
          .prepare(
            `SELECT c.rowid,c.vector ${pool.from} AND c.rowid>? ORDER BY c.rowid LIMIT ?`,
          )
          .all(...pool.params, cursor, Math.min(256, MAX_CHUNKS - scanned));
        if (!rows.length) break;
        for (const row of rows) {
          cursor = Number(row.rowid);
          scanned++;
          if (
            !(row.vector instanceof Uint8Array) ||
            row.vector.byteLength % 4 !== 0
          )
            continue;
          const blob = Buffer.from(row.vector);
          const dimensions = blob.byteLength / 4;
          if (!sum) sum = new Float64Array(dimensions);
          if (dimensions !== sum.length) continue;
          for (let i = 0; i < dimensions; i++)
            sum[i] = (sum[i] ?? 0) + blob.readFloatLE(i * 4);
          count++;
        }
        await yieldEventLoop();
      }
    }
    let vector: Float32Array | null = null;
    if (sum && count > 0) {
      let norm = 0;
      for (const value of sum) norm += value * value;
      norm = Math.sqrt(norm);
      if (norm > 0) {
        vector = new Float32Array(sum.length);
        for (let i = 0; i < sum.length; i++) vector[i] = (sum[i] ?? 0) / norm;
      }
    }
    this.#centroids.set(key, { stamp, vector });
    return vector;
  }

  // Point lookups on the chunk primary key. Cheap next to the full scan above,
  // and the only way to score a lexical passage the 0.80 floor dropped.
  #storedCosines(
    scope: string,
    query: ArrayLike<number>,
    records: readonly StoredChunkRef[],
  ): VectorHit[] {
    if (!records.length) return [];
    const statement = this.#db.prepare(
      "SELECT offset, vector FROM embedding_chunks WHERE kind=? AND record_id=? AND scope=? AND model=?",
    );
    const hits: VectorHit[] = [];
    const seen = new Set<string>();
    for (const record of records) {
      if (record.kind !== "sources" && record.kind !== "knowledge_items")
        continue;
      if (!record.id || record.id.length > 128) continue;
      const key = `${record.kind}\0${record.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rows = statement.all(
        record.kind,
        record.id,
        scope,
        this.#embedder.version,
      );
      for (const row of rows) {
        if (
          !(row.vector instanceof Uint8Array) ||
          row.vector.byteLength !== query.length * 4 ||
          typeof row.offset !== "number"
        )
          continue;
        const blob = Buffer.from(row.vector);
        let score = 0;
        for (let i = 0; i < query.length; i++)
          score += (query[i] ?? 0) * blob.readFloatLE(i * 4);
        if (!Number.isFinite(score)) continue;
        hits.push({ id: record.id, offset: row.offset, score });
      }
    }
    return hits;
  }

  async #nearest(
    table: SearchTable,
    input: SemanticSelection,
    query: Float32Array,
  ) {
    const pool = this.#chunkFrom(table, input);
    const top = new Map<
      string,
      { id: string; offset: number; score: number }
    >();
    let cursor = 0,
      scanned = 0;
    while (scanned < MAX_CHUNKS) {
      const rows = this.#db
        .prepare(
          `SELECT c.rowid,c.record_id,c.offset,c.vector ${pool.from} AND c.rowid>? ORDER BY c.rowid LIMIT ?`,
        )
        .all(...pool.params, cursor, Math.min(256, MAX_CHUNKS - scanned));
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
        if (top.size > MAX_VECTOR_CANDIDATES) {
          const last = [...top.values()]
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
            .at(-1);
          if (last) top.delete(last.id);
        }
      }
      await yieldEventLoop();
    }
    const ranked = [...top.values()].sort(
      (a, b) => b.score - a.score || a.id.localeCompare(b.id),
    );
    return {
      hits: ranked.map(({ id, offset, score }) => ({ id, offset, score })),
      reasons: scanned === MAX_CHUNKS ? ["vector_scan_limit"] : [],
    };
  }

  async close() {
    this.#stopping = true;
    clearTimeout(this.#timer);
    await this.#active;
    await this.#warmTask;
    await this.#tail;
    await this.#embedder.close?.();
    this.#db.close();
  }
}
