export class IntegrityAuditService {
  constructor(database, { blobs = null, sources = null } = {}) {
    this.database = database;
    this.blobs = blobs;
    this.sources = sources;
    this.integrityCheck = database.prepare("PRAGMA integrity_check");
    this.foreignKeyCheck = database.prepare("PRAGMA foreign_key_check");
    this.captureLinkMismatches = database.prepare(`SELECT c.capture_id, c.normalized_count,
      COUNT(ci.article_id) AS linked_count FROM captures c
      LEFT JOIN capture_items ci ON ci.capture_id=c.capture_id
      WHERE c.accepted=1 GROUP BY c.capture_id HAVING c.normalized_count != linked_count`);
    this.articleCountMismatches = database.prepare(`SELECT a.article_id, a.seen_count,
      COUNT(ci.capture_id) AS observed_count FROM articles a
      LEFT JOIN capture_items ci ON ci.article_id=a.article_id
      GROUP BY a.article_id HAVING a.seen_count != observed_count`);
    this.feedWatermarkMismatches = database.prepare(`SELECT f.feed_id, f.last_accepted_at, f.last_item_count,
      c.captured_at AS expected_at, c.normalized_count AS expected_count
      FROM feeds f LEFT JOIN captures c ON c.capture_id=(
        SELECT capture_id FROM captures WHERE feed_id=f.feed_id AND accepted=1 ORDER BY capture_id DESC LIMIT 1
      ) WHERE (f.last_accepted_at IS NOT c.captured_at) OR (f.last_item_count != COALESCE(c.normalized_count, 0))`);
    this.blobCountMismatch = database.prepare(`SELECT pb.content_hash, pb.ref_count,
      (SELECT COUNT(*) FROM capture_sources cs WHERE cs.content_hash=pb.content_hash) AS actual_count
      FROM page_blobs pb WHERE pb.ref_count !=
      (SELECT COUNT(*) FROM capture_sources cs WHERE cs.content_hash=pb.content_hash)`);
    this.blobSourceMissing = database.prepare(`SELECT c.capture_id, c.feed_id FROM captures c
      LEFT JOIN capture_sources cs ON cs.capture_id=c.capture_id WHERE cs.capture_id IS NULL`);
  }

  run() {
    const checks = [
      { name: "sqlite_integrity", rows: this.integrityCheck.all().filter((row) => row.integrity_check !== "ok") },
      { name: "foreign_keys", rows: this.foreignKeyCheck.all() },
      { name: "capture_item_counts", rows: this.captureLinkMismatches.all() },
      { name: "article_observation_counts", rows: this.articleCountMismatches.all() },
      { name: "feed_watermarks", rows: this.feedWatermarkMismatches.all() },
      { name: "page_blob_references", rows: this.collectBlobRows() }
    ].map((check) => ({
      name: check.name,
      passed: check.rows.length === 0,
      issueCount: check.rows.length,
      examples: check.rows.slice(0, 10)
    }));
    return {
      status: checks.every((check) => check.passed) ? "consistent" : "inconsistent",
      checkedAt: new Date().toISOString(),
      checks
    };
  }

  collectBlobRows() {
    if (!this.sources) return [];
    const rows = [];
    for (const row of this.blobCountMismatch.all()) {
      rows.push({ issue: "ref_count_drift", ...row });
    }
    for (const row of this.blobSourceMissing.all()) {
      rows.push({ issue: "capture_source_missing", capture_id: row.capture_id, feed_id: row.feed_id });
    }
    if (this.blobs) {
      const disk = new Set(this.blobs.listEntries().map((entry) => entry.hash));
      for (const blob of this.sources.listBlobs()) {
        if (!disk.has(blob.contentHash)) {
          rows.push({ issue: "blob_file_missing", content_hash: blob.contentHash, ref_count: blob.refCount });
        }
      }
      for (const hash of disk) {
        if (!this.sources.blob(hash)) {
          rows.push({ issue: "orphan_blob_file", content_hash: hash });
        }
      }
    }
    return rows;
  }
}
