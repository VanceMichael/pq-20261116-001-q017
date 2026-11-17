export class PageSourceRepository {
  constructor(database) {
    this.database = database;
    this.upsertBlob = database.prepare(`INSERT INTO page_blobs
      (content_hash, shard_path, byte_size, ref_count, stored_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(content_hash) DO UPDATE SET ref_count = page_blobs.ref_count + 1`);
    this.findBlob = database.prepare("SELECT * FROM page_blobs WHERE content_hash=?");
    this.allBlobs = database.prepare("SELECT * FROM page_blobs");
    this.referenceCount = database.prepare("SELECT COUNT(*) AS count FROM capture_sources WHERE content_hash=?");
    this.zeroRefBlobs = database.prepare("SELECT * FROM page_blobs WHERE ref_count=0");
    this.setRefCount = database.prepare("UPDATE page_blobs SET ref_count=? WHERE content_hash=?");
    this.deleteBlob = database.prepare("DELETE FROM page_blobs WHERE content_hash=?");
    this.insertSource = database.prepare(`INSERT INTO capture_sources
      (capture_id, content_hash, parser_version, byte_size, stored_at) VALUES (?, ?, ?, ?, ?)`);
    this.findSource = database.prepare(`SELECT cs.*, c.feed_id, c.fingerprint, c.captured_at, c.accepted,
      c.reason FROM capture_sources cs JOIN captures c ON c.capture_id=cs.capture_id
      WHERE cs.capture_id=?`);
    this.findForFeed = database.prepare(`SELECT cs.* FROM capture_sources cs
      JOIN captures c ON c.capture_id=cs.capture_id WHERE c.feed_id=? AND cs.capture_id=?`);
  }

  attachBlob({ contentHash, shardPath, byteSize, storedAt }) {
    this.upsertBlob.run(contentHash, shardPath, byteSize, storedAt);
  }

  blob(contentHash) {
    const row = this.findBlob.get(contentHash);
    return row ? mapBlob(row) : null;
  }

  listBlobs() {
    return this.allBlobs.all().map(mapBlob);
  }

  actualReferenceCount(contentHash) {
    return Number(this.referenceCount.get(contentHash).count);
  }

  listZeroRefBlobs() {
    return this.zeroRefBlobs.all().map(mapBlob);
  }

  repairRefCount(contentHash, count) {
    this.setRefCount.run(count, contentHash);
  }

  removeBlobRow(contentHash) {
    return this.deleteBlob.run(contentHash);
  }

  recordSource({ captureId, contentHash, parserVersion, byteSize, storedAt }) {
    this.insertSource.run(captureId, contentHash, parserVersion, byteSize, storedAt);
  }

  sourceForCapture(captureId) {
    const row = this.findSource.get(captureId);
    return row ? mapSource(row) : null;
  }

  sourceForFeedCapture(feedId, captureId) {
    const row = this.findForFeed.get(feedId, captureId);
    return row ? mapSource(row) : null;
  }
}

function mapBlob(row) {
  return {
    contentHash: row.content_hash,
    shardPath: row.shard_path,
    byteSize: row.byte_size,
    refCount: row.ref_count,
    storedAt: row.stored_at
  };
}

function mapSource(row) {
  return {
    captureId: row.capture_id,
    contentHash: row.content_hash,
    parserVersion: row.parser_version,
    byteSize: row.byte_size,
    storedAt: row.stored_at,
    feedId: row.feed_id ?? null,
    fingerprint: row.fingerprint ?? null,
    capturedAt: row.captured_at ?? null,
    accepted: row.accepted === undefined || row.accepted === null ? null : Boolean(row.accepted),
    reason: row.reason ?? null
  };
}
