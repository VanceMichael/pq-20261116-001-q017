import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeArchive, page, standardItems, baseFeed, captureTime } from "../helpers.js";
import { NewsArchive } from "../../src/service/archive.js";
import { BlobStore, TEMP_PREFIX } from "../../src/store/blob-store.js";
import { PARSER_VERSION } from "../../src/feed/html.js";
import { createHttpServer } from "../../src/http/server.js";

const feed = baseFeed;

function blobFiles(blobRoot) {
  const files = [];
  for (const shard of readdirSync(blobRoot, { withFileTypes: true })) {
    if (!shard.isDirectory() || shard.name === "tmp") continue;
    for (const entry of readdirSync(join(blobRoot, shard.name), { withFileTypes: true })) {
      if (entry.isFile()) files.push(join(shard.name, entry.name));
    }
  }
  return files;
}

test("saves the raw accepted page outside SQLite and links it with the parser version", async (t) => {
  const { archive, directory } = await makeArchive(t);
  archive.registerFeed(feed);
  const html = page(standardItems(4));
  const result = archive.importSnapshot("daily-main", html, captureTime(1));
  assert.equal(result.accepted, true);
  assert.equal(result.source.parserVersion, PARSER_VERSION);
  assert.equal(result.source.byteSize, Buffer.byteLength(html, "utf8"));
  const blobRoot = join(directory, "blobs");
  const files = blobFiles(blobRoot);
  assert.equal(files.length, 1);
  assert.equal(readFileSync(join(blobRoot, files[0]), "utf8"), html);
  const row = archive.database.prepare("SELECT * FROM page_blobs").get();
  assert.equal(row.content_hash, result.fingerprint);
  assert.equal(row.ref_count, 1);
  assert.equal(row.byte_size, result.source.byteSize);
  const source = archive.database.prepare("SELECT * FROM capture_sources").get();
  assert.equal(source.capture_id, result.captureId);
  assert.equal(source.parser_version, PARSER_VERSION);
  // The articles table and its queries never carry the multi-megabyte payload.
  const articleColumns = archive.database.prepare("PRAGMA table_info(articles)").all().map((c) => c.name);
  assert.ok(!articleColumns.includes("raw_html"));
});

test("failing blob write aborts before any capture or article row is created", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(feed);
  const failingStore = {
    hash: (content) => archive.blobs.hash(content),
    shardPath: (hash) => archive.blobs.shardPath(hash),
    store() {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    },
    read: (hash) => archive.blobs.read(hash),
    delete: (hash) => archive.blobs.delete(hash),
    exists: (hash) => archive.blobs.exists(hash),
    listEntries: () => archive.blobs.listEntries(),
    listTempFiles: () => archive.blobs.listTempFiles(),
    removeTempFile: (path) => archive.blobs.removeTempFile(path),
    root: archive.blobs.root
  };
  archive.imports.blobs = failingStore;
  assert.throws(() => archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1)), /disk full/);
  assert.equal(archive.listCaptures("daily-main").length, 0);
  assert.equal(archive.articles.stats("daily-main").total, 0);
  assert.equal(archive.database.prepare("SELECT COUNT(*) AS n FROM page_blobs").get().n, 0);
});

test("cleans an orphaned blob when the capture transaction rolls back", async (t) => {
  const { archive, directory } = await makeArchive(t);
  archive.registerFeed(feed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  archive.database.exec(`CREATE TRIGGER fail_capture_link BEFORE INSERT ON capture_items
    BEGIN SELECT RAISE(ABORT, 'simulated storage fault'); END;`);
  const changed = page([{ id: 5 }, { id: 6 }, { id: 7 }, { id: 8 }]);
  assert.throws(() => archive.importSnapshot("daily-main", changed, captureTime(2)), /simulated storage fault/);
  archive.database.exec("DROP TRIGGER fail_capture_link");
  const blobRoot = join(directory, "blobs");
  assert.equal(blobFiles(blobRoot).length, 1);
  assert.equal(archive.database.prepare("SELECT COUNT(*) AS n FROM page_blobs").get().n, 1);
  assert.deepEqual(archive.reconcileBlobs().orphanFilesRemoved, []);
  // The failed import can be retried cleanly once the fault is gone.
  const retried = archive.importSnapshot("daily-main", changed, captureTime(2));
  assert.equal(retried.accepted, true);
  assert.equal(blobFiles(blobRoot).length, 2);
});

test("recovers abandoned temp files and orphan blobs when the archive reopens", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "news-archive-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "archive.sqlite");
  const first = new NewsArchive(filename);
  first.registerFeed(feed);
  const html = page(standardItems(4));
  const result = first.importSnapshot("daily-main", html, captureTime(1));
  // Simulate a crash mid-save: a leftover temp file and an orphaned blob row+file.
  const blobRoot = join(directory, "blobs");
  writeFileSync(join(blobRoot, "tmp", `${TEMP_PREFIX}crashed.tmp`), "partial bytes");
  const store = new BlobStore(blobRoot);
  const orphan = store.store("<html>orphan</html>");
  first.database.prepare(`INSERT INTO page_blobs (content_hash, shard_path, byte_size, ref_count, stored_at)
    VALUES (?, ?, 16, 0, ?)`).run(orphan.hash, orphan.shardPath, captureTime(1));
  first.close();

  const reopened = new NewsArchive(filename);
  assert.equal(reopened.lastReconciliation.tempFilesRemoved, 1);
  assert.deepEqual(reopened.lastReconciliation.missingReferenced, []);
  assert.deepEqual(reopened.lastReconciliation.orphanRowsRemoved.map((r) => r.contentHash), [orphan.hash]);
  assert.equal(blobFiles(blobRoot).length, 1);
  assert.deepEqual(reopened.blobs.listTempFiles(), []);
  // The referenced capture blob survived and still serves its original bytes.
  const source = reopened.captureSource("daily-main", result.captureId);
  assert.equal(source.html, html);
  assert.equal(reopened.auditIntegrity().status, "consistent");
  reopened.close();
});

test("reconciles a drifted reference count without deleting a still-referenced blob", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(feed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  archive.database.prepare("UPDATE page_blobs SET ref_count=99").run();
  const report = archive.reconcileBlobs();
  assert.equal(report.repairedRefCounts[0].storedRefCount, 99);
  assert.equal(report.repairedRefCounts[0].actualRefCount, 1);
  assert.equal(report.missingReferenced.length, 0);
  assert.equal(archive.auditIntegrity().status, "consistent");
});

test("shares one blob across captures and feeds that return the same body", async (t) => {
  const { archive, directory } = await makeArchive(t);
  archive.registerFeed(feed);
  const secondFeed = { ...baseFeed, feedId: "weekend-brief" };
  archive.registerFeed(secondFeed);
  const sharedHtml = page(standardItems(4));
  const first = archive.importSnapshot("daily-main", sharedHtml, captureTime(1));
  const second = archive.importSnapshot("weekend-brief", sharedHtml, captureTime(1));
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.source.reused, true);
  const blobRoot = join(directory, "blobs");
  assert.equal(blobFiles(blobRoot).length, 1);
  const row = archive.database.prepare("SELECT * FROM page_blobs").get();
  assert.equal(row.ref_count, 2);
  assert.equal(archive.database.prepare("SELECT COUNT(*) AS n FROM capture_sources").get().n, 2);
  // Removing one capture's source link must not erase the bytes the other still points to.
  archive.database.prepare("DELETE FROM capture_sources WHERE capture_id=?").run(first.captureId);
  assert.ok(archive.blobs.exists(first.fingerprint));
  const report = archive.reconcileBlobs();
  assert.equal(report.repairedRefCounts[0].actualRefCount, 1);
  assert.equal(archive.captureSource("weekend-brief", second.captureId).html, sharedHtml);
});

test("keeps the raw bytes of a rejected capture so operators can trace the decision", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(feed);
  const rejectedHtml = page(standardItems(2, 30));
  const result = archive.importSnapshot("daily-main", rejectedHtml, captureTime(1));
  assert.equal(result.accepted, false);
  assert.match(result.reason, /too_few_usable_items/);
  const [capture] = archive.listCaptures("daily-main");
  const source = archive.captureSource("daily-main", capture.captureId);
  assert.equal(source.html, rejectedHtml);
  assert.equal(source.accepted, false);
  assert.equal(source.parserVersion, PARSER_VERSION);
  const replayed = archive.replayCapture("daily-main", capture.captureId);
  assert.equal(replayed.recorded.accepted, false);
  assert.match(replayed.recorded.reason, /too_few_usable_items/);
  assert.equal(replayed.current.normalizedCount, 2);
});

test("replays a capture read-only without changing observations or the feed watermark", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(feed);
  const first = archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  const before = {
    captures: archive.listCaptures("daily-main").length,
    total: archive.articles.stats("daily-main").total,
    seen: archive.listItems("daily-main").items.map((item) => item.seenCount),
    watermark: archive.feedStatus("daily-main").lastAcceptedAt
  };
  const replayed = archive.replayCapture("daily-main", first.captureId);
  assert.equal(replayed.replay, true);
  assert.equal(replayed.recorded.fingerprint, replayed.current.fingerprint);
  assert.equal(replayed.current.normalizedCount, 4);
  assert.equal(replayed.recorded.parserVersion, PARSER_VERSION);
  assert.equal(replayed.current.parserChanged, false);
  const after = {
    captures: archive.listCaptures("daily-main").length,
    total: archive.articles.stats("daily-main").total,
    seen: archive.listItems("daily-main").items.map((item) => item.seenCount),
    watermark: archive.feedStatus("daily-main").lastAcceptedAt
  };
  assert.deepEqual(after, before);
  assert.equal(archive.database.prepare("SELECT COUNT(*) AS n FROM capture_sources").get().n, 1);
});

test("replay refuses to serve tampered bytes and the fingerprint idempotent path stays unchanged", async (t) => {
  const { archive, directory } = await makeArchive(t);
  archive.registerFeed(feed);
  const result = archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  const blob = archive.database.prepare("SELECT shard_path FROM page_blobs").get();
  writeFileSync(join(directory, "blobs", blob.shard_path), page(standardItems(3)));
  assert.throws(() => archive.replayCapture("daily-main", result.captureId), (error) => error.code === "blob_corrupt");
  // Resubmitting the identical page remains the old idempotent no-write replay path.
  const again = archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(2));
  assert.equal(again.replay, true);
  assert.equal(again.captureId, result.captureId);
  assert.equal(archive.listCaptures("daily-main").length, 1);
});

test("scopes capture source lookups to the owning feed", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(feed);
  const result = archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  assert.throws(() => archive.captureSource("missing-feed", result.captureId), /unknown feed/);
  archive.registerFeed({ ...baseFeed, feedId: "other-feed" });
  assert.throws(() => archive.captureSource("other-feed", result.captureId), (error) => error.code === "source_missing");
  assert.throws(() => archive.replayCapture("other-feed", result.captureId), (error) => error.code === "capture_not_found");
});

test("preserves the five megabyte page limit before any blob is written", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(feed);
  const oversized = `<!doctype html><html><body>${"a".repeat(5_000_001)}</body></html>`;
  assert.throws(() => archive.importSnapshot("daily-main", oversized, captureTime(1)), /5 MB/);
  assert.equal(archive.listCaptures("daily-main").length, 0);
  assert.equal(archive.reconcileBlobs().orphanFilesRemoved.length, 0);
});

test("integrity audit flags blob drift, missing files, orphan files and sources independently of reconciliation", async (t) => {
  const { archive, directory } = await makeArchive(t);
  archive.registerFeed(feed);
  const result = archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  archive.database.prepare("UPDATE page_blobs SET ref_count=5").run();
  archive.blobs.store("<html>disk orphan</html>");
  archive.database.prepare(`INSERT INTO captures (feed_id, fingerprint, captured_at, accepted,
    candidate_count, normalized_count, rejected_count, duplicate_count)
    VALUES ('daily-main', ?, '2026-11-16T02:00:09.000Z', 0, 0, 0, 0, 0)`).run("1".repeat(64));
  const report = archive.auditIntegrity();
  const check = report.checks.find((item) => item.name === "page_blob_references");
  assert.equal(report.status, "inconsistent");
  const issues = check.examples.map((row) => row.issue);
  assert.ok(issues.includes("ref_count_drift"));
  assert.ok(issues.includes("orphan_blob_file"));
  assert.ok(issues.includes("capture_source_missing"));
  // A missing referenced file is reported rather than hidden.
  archive.blobs.delete(result.fingerprint);
  const afterDelete = archive.auditIntegrity();
  const issuesAfter = afterDelete.checks.find((item) => item.name === "page_blob_references")
    .examples.map((row) => row.issue);
  assert.ok(issuesAfter.includes("blob_file_missing"));
});

test("rollback cleanup never removes a blob shared with a committed capture", async (t) => {
  const { archive, directory } = await makeArchive(t);
  archive.registerFeed(feed);
  const sharedHtml = page(standardItems(4));
  const first = archive.importSnapshot("daily-main", sharedHtml, captureTime(1));
  archive.registerFeed({ ...baseFeed, feedId: "partner-feed" });
  const partner = archive.importSnapshot("partner-feed", sharedHtml, captureTime(1));
  assert.equal(partner.source.reused, true);
  assert.equal(archive.database.prepare("SELECT ref_count FROM page_blobs").get().ref_count, 2);
  archive.database.exec(`CREATE TRIGGER fail_third_capture BEFORE INSERT ON capture_items
    WHEN NEW.capture_id > 2
    BEGIN SELECT RAISE(ABORT, 'simulated third-write fault'); END;`);
  archive.registerFeed({ ...baseFeed, feedId: "failing-feed" });
  assert.throws(() => archive.importSnapshot("failing-feed", sharedHtml, captureTime(1)), /simulated third-write fault/);
  archive.database.exec("DROP TRIGGER fail_third_capture");
  // The shared blob and both committed references survive the failed third import.
  assert.ok(archive.blobs.exists(first.fingerprint));
  assert.equal(archive.database.prepare("SELECT ref_count FROM page_blobs").get().ref_count, 2);
  assert.equal(archive.captureSource("partner-feed", partner.captureId).html, sharedHtml);
  assert.equal(blobFiles(join(directory, "blobs")).length, 1);
  assert.equal(archive.auditIntegrity().status, "consistent");
});

test("reports a structured conflict when a legacy capture has no stored source", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(feed);
  const imported = archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  archive.database.prepare("DELETE FROM capture_sources WHERE capture_id=?").run(imported.captureId);
  assert.throws(() => archive.captureSource("daily-main", imported.captureId), (error) =>
    error.code === "source_missing" && error.statusCode === 404);
  assert.throws(() => archive.replayCapture("daily-main", imported.captureId), (error) =>
    error.code === "source_missing" && error.statusCode === 409);
});

test("serves the original bytes and the replay verdict over HTTP without side effects", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(feed);
  const html = page(standardItems(4));
  const imported = archive.importSnapshot("daily-main", html, captureTime(1));
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const root = `http://127.0.0.1:${address.port}/v1/feeds/daily-main/runs`;

  const raw = await fetch(`${root}/${imported.captureId}/source`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(raw.headers.get("x-content-hash"), imported.fingerprint);
  assert.equal(raw.headers.get("x-parser-version"), PARSER_VERSION);
  assert.equal(await raw.text(), html);

  const missing = await fetch(`${root}/9999/source`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "invalid_request");

  const replay = await fetch(`${root}/${imported.captureId}/replay`);
  assert.equal(replay.status, 200);
  const body = await replay.json();
  assert.equal(body.recorded.accepted, true);
  assert.equal(body.current.normalizedCount, 4);
  assert.equal(body.source.contentHash, imported.fingerprint);

  // A capture whose source row was removed is reported as a structured 404/409.
  archive.database.prepare("DELETE FROM capture_sources WHERE capture_id=?").run(imported.captureId);
  const missingSource = await fetch(`${root}/${imported.captureId}/source`);
  assert.equal(missingSource.status, 404);
  const missingReplay = await fetch(`${root}/${imported.captureId}/replay`);
  assert.equal(missingReplay.status, 409);
  assert.equal((await missingReplay.json()).error, "invalid_request");

  assert.equal(archive.listCaptures("daily-main").length, 1);
  assert.equal(archive.articles.stats("daily-main").total, 4);
});
