import { rmdirSync } from "node:fs";
import { join } from "node:path";

// Reconciles the content-addressed blob directory with SQLite metadata.
// It is idempotent and safe to run on every archive open:
//   1. remove temp files left by a crash during a blob write,
//   2. repair reference counts from capture_sources (the source of truth),
//   3. drop zero-reference blob rows together with their files,
//   4. remove files that no tracked row references,
//   5. report any referenced file that is missing rather than silently recreating it.
export class BlobReconcileService {
  constructor({ blobs, sources, clock = () => new Date() }) {
    this.blobs = blobs;
    this.sources = sources;
    this.clock = clock;
  }

  sweep() {
    const report = {
      checkedAt: this.clock().toISOString(),
      tempFilesRemoved: 0,
      repairedRefCounts: [],
      orphanRowsRemoved: [],
      orphanFilesRemoved: [],
      missingReferenced: [],
      blobsTracked: 0
    };
    for (const tempFile of this.blobs.listTempFiles()) {
      this.blobs.removeTempFile(tempFile);
      report.tempFilesRemoved += 1;
    }

    const diskEntries = new Map(this.blobs.listEntries().map((entry) => [entry.hash, entry]));
    const trackedHashes = new Set();

    const removedShards = new Set();
    for (const blob of this.sources.listBlobs()) {
      trackedHashes.add(blob.contentHash);
      const actual = this.sources.actualReferenceCount(blob.contentHash);
      if (actual === 0) {
        this.sources.removeBlobRow(blob.contentHash);
        this.blobs.delete(blob.contentHash);
        diskEntries.delete(blob.contentHash);
        report.orphanRowsRemoved.push({ contentHash: blob.contentHash, shardPath: blob.shardPath });
        removedShards.add(blob.shardPath.slice(0, 2));
        continue;
      }
      if (blob.refCount !== actual) {
        this.sources.repairRefCount(blob.contentHash, actual);
        report.repairedRefCounts.push({
          contentHash: blob.contentHash,
          storedRefCount: blob.refCount,
          actualRefCount: actual
        });
      }
      if (!this.blobs.exists(blob.contentHash)) {
        report.missingReferenced.push({ contentHash: blob.contentHash, refCount: actual });
      }
      report.blobsTracked += 1;
    }

    for (const [hash, entry] of diskEntries) {
      if (trackedHashes.has(hash)) continue;
      this.blobs.delete(hash);
      report.orphanFilesRemoved.push({ contentHash: hash, shardPath: entry.shardPath });
      removedShards.add(entry.shardPath.slice(0, 2));
    }

    // rmdirSync only succeeds while the shard is empty, so a shard that still
    // holds a referenced blob is left untouched.
    for (const shard of removedShards) {
      try {
        rmdirSync(join(this.blobs.root, shard));
      } catch {
        // Non-empty or already removed: nothing to do.
      }
    }
    return report;
  }
}
