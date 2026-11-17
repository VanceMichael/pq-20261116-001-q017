import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, TEMP_PREFIX } from "../../src/store/blob-store.js";

function fakeSources(initialBlobs, references) {
  const blobs = new Map(initialBlobs.map((blob) => [blob.contentHash, { ...blob }]));
  return {
    listBlobs: () => initialBlobs.map((blob) => ({ ...blobs.get(blob.contentHash) })),
    actualReferenceCount: (hash) => references.get(hash) ?? 0,
    removeBlobRow: (hash) => blobs.delete(hash),
    repairRefCount: (hash, count) => { blobs.get(hash).refCount = count; },
    blob: (hash) => blobs.get(hash) ?? null
  };
}

async function freshRoot() {
  return mkdtemp(join(tmpdir(), "reconcile-test-"));
}

test("sweep removes temp files, repairs drift and deletes zero-reference rows and files", async (t) => {
  const root = await freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new BlobStore(root);
  const kept = store.store("<html>kept</html>");
  const orphan = store.store("<html>orphan</html>");
  writeFileSync(join(root, "tmp", `${TEMP_PREFIX}left.tmp`), "partial");
  const sources = fakeSources(
    [
      { contentHash: kept.hash, shardPath: kept.shardPath, refCount: 9 },
      { contentHash: orphan.hash, shardPath: orphan.shardPath, refCount: 1 }
    ],
    new Map([[kept.hash, 2]])
  );
  const { BlobReconcileService } = await import("../../src/service/blob-reconcile-service.js");
  const service = new BlobReconcileService({ blobs: store, sources, clock: () => new Date("2026-11-16T00:00:00Z") });
  const report = service.sweep();

  assert.equal(report.tempFilesRemoved, 1);
  assert.equal(report.repairedRefCounts.length, 1);
  assert.equal(report.repairedRefCounts[0].contentHash, kept.hash);
  assert.equal(report.repairedRefCounts[0].storedRefCount, 9);
  assert.equal(report.repairedRefCounts[0].actualRefCount, 2);
  assert.deepEqual(report.orphanRowsRemoved.map((item) => item.contentHash), [orphan.hash]);
  assert.equal(store.exists(kept.hash), true);
  assert.equal(store.exists(orphan.hash), false);
  assert.equal(sources.blob(kept.hash).refCount, 2);
  assert.equal(sources.blob(orphan.hash), null);
  assert.equal(report.blobsTracked, 1);
});

test("sweep deletes disk files without rows and reports missing referenced files", async (t) => {
  const root = await freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new BlobStore(root);
  const referenced = store.store("<html>referenced</html>");
  const diskOnly = store.store("<html>disk only</html>");
  store.delete(referenced.hash);
  const sources = fakeSources(
    [{ contentHash: referenced.hash, shardPath: referenced.shardPath, refCount: 1 }],
    new Map([[referenced.hash, 1]])
  );
  const { BlobReconcileService } = await import("../../src/service/blob-reconcile-service.js");
  const report = new BlobReconcileService({ blobs: store, sources }).sweep();

  assert.deepEqual(report.missingReferenced, [{ contentHash: referenced.hash, refCount: 1 }]);
  assert.deepEqual(report.orphanFilesRemoved.map((item) => item.contentHash), [diskOnly.hash]);
  assert.equal(store.exists(diskOnly.hash), false);
  // The row of a still-referenced but missing blob is retained for operator follow-up.
  assert.equal(sources.blob(referenced.hash) !== null, true);
});

test("sweep is idempotent: a second run finds nothing to do", async (t) => {
  const root = await freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new BlobStore(root);
  const blob = store.store("<html>stable</html>");
  const sources = fakeSources(
    [{ contentHash: blob.hash, shardPath: blob.shardPath, refCount: 1 }],
    new Map([[blob.hash, 1]])
  );
  const { BlobReconcileService } = await import("../../src/service/blob-reconcile-service.js");
  const service = new BlobReconcileService({ blobs: store, sources });
  const first = service.sweep();
  assert.deepEqual(first.missingReferenced, []);
  const second = service.sweep();
  assert.equal(second.tempFilesRemoved, 0);
  assert.equal(second.repairedRefCounts.length, 0);
  assert.equal(second.orphanRowsRemoved.length, 0);
  assert.equal(second.orphanFilesRemoved.length, 0);
  assert.equal(second.blobsTracked, 1);
});
