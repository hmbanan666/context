-- Schema and fictional rows produced by pre-cleanup commit 2fc7116.
-- Inert legacy receipts are placeholders; no signing or work protocol is exercised.
PRAGMA user_version = 1;
CREATE TABLE sources (
          id TEXT PRIMARY KEY NOT NULL CHECK(length(id) > 0),
          text TEXT NOT NULL CHECK(length(text) > 0),
          origin TEXT NOT NULL CHECK(length(origin) > 0),
          scope TEXT NOT NULL CHECK(length(scope) > 0),
          captured_at TEXT NOT NULL,
          checksum TEXT NOT NULL CHECK(length(checksum) = 64),
          status TEXT NOT NULL CHECK(status = 'unreviewed')
        ) STRICT;
CREATE TABLE capture_requests (
            scope TEXT NOT NULL,
            request_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            source_id TEXT NOT NULL REFERENCES sources(id),
            PRIMARY KEY (scope, request_key)
          ) STRICT;
CREATE VIRTUAL TABLE sources_fts USING fts5(
            text, content='sources', content_rowid='rowid'
          );
CREATE TRIGGER sources_insert AFTER INSERT ON sources BEGIN
            INSERT INTO sources_fts(rowid, text) VALUES (new.rowid, new.text);
          END;
CREATE TABLE source_metadata (
          source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),
          type TEXT NOT NULL CHECK(type IN ('note', 'document')),
          title TEXT,
          created_at TEXT,
          source_uri TEXT
        ) STRICT;
CREATE TABLE source_files (
          source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id),
          filename TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK(media_type IN ('text/plain', 'text/markdown')),
          byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 16384),
          checksum TEXT NOT NULL CHECK(length(checksum) = 64),
          original BLOB NOT NULL CHECK(length(original) = byte_length)
        ) STRICT;
CREATE TABLE knowledge_items (
          id TEXT PRIMARY KEY NOT NULL,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('idea', 'observation', 'decision_proposal')),
          text TEXT NOT NULL,
          source_refs TEXT NOT NULL,
          creator TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
CREATE INDEX knowledge_items_scope ON knowledge_items(scope, created_at, id);
CREATE TABLE knowledge_relations (
          id TEXT PRIMARY KEY NOT NULL,
          scope TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('supports', 'contradicts', 'supersedes')),
          from_id TEXT NOT NULL REFERENCES knowledge_items(id),
          to_id TEXT NOT NULL REFERENCES knowledge_items(id),
          source_refs TEXT NOT NULL,
          creator TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CHECK(from_id <> to_id)
        ) STRICT;
CREATE INDEX knowledge_relations_scope ON knowledge_relations(scope, created_at, id);
CREATE TABLE knowledge_reviews (
          id TEXT PRIMARY KEY NOT NULL,
          knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id),
          scope TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('reviewed', 'rejected', 'approved')),
          evidence TEXT NOT NULL,
          reviewer TEXT NOT NULL,
          signed_receipt TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
CREATE INDEX knowledge_reviews_item ON knowledge_reviews(knowledge_id, scope);
CREATE TABLE knowledge_requests (
          scope TEXT NOT NULL,
          request_key TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('add', 'relate', 'review')),
          fingerprint TEXT NOT NULL,
          record_id TEXT NOT NULL,
          PRIMARY KEY(scope, request_key)
        ) STRICT;
CREATE VIRTUAL TABLE knowledge_items_fts USING fts5(text, content='knowledge_items', content_rowid='rowid');
CREATE TRIGGER knowledge_items_fts_insert AFTER INSERT ON knowledge_items BEGIN
            INSERT INTO knowledge_items_fts(rowid,text) VALUES(new.rowid,new.text);
          END;
CREATE TABLE processing_jobs (
          id TEXT PRIMARY KEY NOT NULL,
          source_id TEXT NOT NULL REFERENCES sources(id),
          scope TEXT NOT NULL,
          processor_version TEXT NOT NULL CHECK(processor_version = 'memory-v1'),
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
          attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          next_attempt_at INTEGER,
          lease_token TEXT,
          lease_expires_at INTEGER,
          output TEXT,
          result_ids TEXT NOT NULL DEFAULT '[]',
          last_error TEXT CHECK(last_error IN ('model_unavailable', 'invalid_output', 'processing_failed')),
          CHECK((status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
          CHECK((status = 'queued') = (next_attempt_at IS NOT NULL))
        ) STRICT;
CREATE INDEX processing_jobs_claim ON processing_jobs(scope, status, next_attempt_at, lease_expires_at);
CREATE TABLE processing_requests (
          scope TEXT NOT NULL,
          request_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          job_id TEXT NOT NULL REFERENCES processing_jobs(id),
          PRIMARY KEY(scope, request_key)
        ) STRICT;
CREATE TABLE work_authorizations (
          id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, request_key TEXT NOT NULL,
          intent_id TEXT NOT NULL REFERENCES knowledge_items(id),
          approval_id TEXT NOT NULL REFERENCES knowledge_reviews(id),
          reviewer TEXT NOT NULL, receipt TEXT NOT NULL, fingerprint TEXT NOT NULL,
          created_at TEXT NOT NULL, UNIQUE(scope, request_key)
        ) STRICT;
CREATE INDEX work_scope ON work_authorizations(scope, id);
CREATE TABLE work_observations (
          id TEXT PRIMARY KEY NOT NULL, work_id TEXT NOT NULL REFERENCES work_authorizations(id),
          request_key TEXT NOT NULL, pull_number INTEGER NOT NULL,
          evidence TEXT, error TEXT CHECK(error IS NULL OR error = 'github_unavailable'),
          observed_at TEXT NOT NULL, UNIQUE(work_id, request_key),
          CHECK((evidence IS NULL) <> (error IS NULL))
        ) STRICT;
CREATE INDEX work_observation_history ON work_observations(work_id);
INSERT INTO sources VALUES ('d263f390-9331-4685-b96d-7f2d24dd9891', 'Fictional garden notebook: preserve the violet lamp.', 'mcp:fictional-cli', 'private:personal', '2026-11-02T09:36:55.959Z', '55ef3f547e97253be76e7592d691479e2d2c29d0b1d751b7c607fc4964b50123', 'unreviewed');
INSERT INTO sources VALUES ('9f53eabe-c122-484f-87e6-5c068a9e751b', '﻿Fictional garden file
', 'fixture:file', 'private:personal', '2026-11-02T09:36:55.965Z', 'e42f5a98bc840d945e8e5d6fe910656f2d33a3329114be9f0ef29f8511ef22f4', 'unreviewed');
INSERT INTO sources VALUES ('1cfb5c4f-3e58-45e8-b067-da078685da58', 'Fictional old area source', 'fixture:legacy', 'synthetic:legacy', '2026-11-02T09:36:55.967Z', '744d8a095c23b42fedf774ba2470f2984cf5114e18e8de0ad2e608fff7c55dff', 'unreviewed');
INSERT INTO capture_requests VALUES ('private:personal', 'legacy-note', 'fb7e20f7162616a057637ba05e496e58b4617c753987d85b2eddcaf01f9ece93', 'd263f390-9331-4685-b96d-7f2d24dd9891');
INSERT INTO capture_requests VALUES ('private:personal', 'legacy-file', '43684795f3237214d89b797c8a4799c6494ced03957063a047b5aa37e488e7d3', '9f53eabe-c122-484f-87e6-5c068a9e751b');
INSERT INTO capture_requests VALUES ('synthetic:legacy', 'legacy-capture', 'a60f5ddb9afbfaf868875a9163002dd927d58da11cc63cdf645001237608a358', '1cfb5c4f-3e58-45e8-b067-da078685da58');
INSERT INTO source_metadata VALUES ('d263f390-9331-4685-b96d-7f2d24dd9891', 'note', 'Fictional notebook', '2026-10-01T12:00:00Z', NULL);
INSERT INTO source_metadata VALUES ('9f53eabe-c122-484f-87e6-5c068a9e751b', 'document', NULL, NULL, NULL);
INSERT INTO source_files VALUES ('9f53eabe-c122-484f-87e6-5c068a9e751b', 'garden.md', 'text/markdown', 26, 'e42f5a98bc840d945e8e5d6fe910656f2d33a3329114be9f0ef29f8511ef22f4', X'efbbbf46696374696f6e616c2067617264656e2066696c650d0a');
INSERT INTO knowledge_items VALUES ('5d564d3d-8726-428d-b797-05fc6d04e71c', 'private:personal', 'idea', 'Violet lamp fixture', '[{"sourceId":"d263f390-9331-4685-b96d-7f2d24dd9891","quote":"violet lamp"}]', '{"kind":"model","name":"fixture"}', '2026-11-02T09:36:55.972Z');
INSERT INTO knowledge_items VALUES ('0ae8ae2f-0e9f-4884-8412-34ba4846e941', 'private:personal', 'decision_proposal', 'Violet lamp fixture', '[{"sourceId":"d263f390-9331-4685-b96d-7f2d24dd9891","quote":"violet lamp"}]', '{"kind":"model","name":"fixture"}', '2026-11-02T09:36:55.975Z');
INSERT INTO knowledge_relations VALUES ('1011b97b-d47f-49e2-810f-384cfe944c10', 'private:personal', 'supports', '5d564d3d-8726-428d-b797-05fc6d04e71c', '0ae8ae2f-0e9f-4884-8412-34ba4846e941', '[{"sourceId":"d263f390-9331-4685-b96d-7f2d24dd9891","quote":"violet lamp"}]', '{"kind":"model","name":"fixture"}', '2026-11-02T09:36:55.980Z');
INSERT INTO knowledge_reviews VALUES ('legacy-review', '5d564d3d-8726-428d-b797-05fc6d04e71c', 'private:personal', 'rejected', 'Fictional historical status', 'fixture', '{}', '2026-10-01T13:00:00Z');
INSERT INTO knowledge_requests VALUES ('private:personal', 'legacy-idea', 'add', '4d32095b59a86bc68213f13809a7339420588c793ebaff36401253fda91ae4e4', '5d564d3d-8726-428d-b797-05fc6d04e71c');
INSERT INTO knowledge_requests VALUES ('private:personal', 'legacy-decision', 'add', 'fae76cfee20f12c15fc4b2f9aeb3800aa2f27af8d062e36a3ef215f8375943b9', '0ae8ae2f-0e9f-4884-8412-34ba4846e941');
INSERT INTO knowledge_requests VALUES ('private:personal', 'legacy-relation', 'relate', '9c095bc439a27d203c154a26b16b3692bf92241c607d3ac6e4b6e9ecb5aa345f', '1011b97b-d47f-49e2-810f-384cfe944c10');
INSERT INTO knowledge_requests VALUES ('private:personal', 'legacy-review', 'review', 'historical-fingerprint', 'legacy-review');
INSERT INTO processing_jobs VALUES ('5ad4d366-9544-475a-8292-d4edec084bac', '9f53eabe-c122-484f-87e6-5c068a9e751b', 'private:personal', 'memory-v1', 'queued', 0, '2026-11-02T09:36:55.984Z', '2026-11-02T09:36:55.984Z', 1793612215984, NULL, NULL, NULL, '[]', NULL);
INSERT INTO processing_requests VALUES ('private:personal', 'legacy-job', 'ae9b828efa5e6691a3f6deb592b734cc4d7a8b9e6f2be4e3de06e137f7a991a7', '5ad4d366-9544-475a-8292-d4edec084bac');
INSERT INTO work_authorizations VALUES ('legacy-work', 'private:personal', 'legacy-work', '0ae8ae2f-0e9f-4884-8412-34ba4846e941', 'legacy-review', 'fixture', '{}', 'historical-fingerprint', '2026-10-01T13:00:00Z');
INSERT INTO work_observations VALUES ('legacy-observation', 'legacy-work', 'legacy-refresh', 1, NULL, 'github_unavailable', '2026-10-01T13:00:00Z');
