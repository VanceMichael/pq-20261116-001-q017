import { extractLinks, pageFingerprint, PARSER_VERSION } from "../feed/html.js";
import { normalizeCandidates } from "../feed/normalize.js";
import { validateFeedId } from "../store/feed-repository.js";
import { assessCapture, validateCapturedAt } from "./capture-policy.js";

export class ImportService {
  constructor({ database, feeds, captures, articles, sources, blobs, clock = () => new Date() }) {
    this.database = database;
    this.feeds = feeds;
    this.captures = captures;
    this.articles = articles;
    this.sources = sources;
    this.blobs = blobs;
    this.clock = clock;
  }

  importHtml(feedId, html, capturedAtValue) {
    validateFeedId(feedId);
    const feed = this.feeds.get(feedId);
    if (!feed) throw new Error(`unknown feed: ${feedId}`);
    const capturedAt = validateCapturedAt(capturedAtValue, this.clock());
    const fingerprint = pageFingerprint(html);
    const previous = this.captures.findByFingerprint(feedId, fingerprint);
    if (previous) return { ...previous, replay: true, stats: this.articles.stats(feedId) };

    const candidates = extractLinks(html, feed.baseUrl);
    const normalized = normalizeCandidates(candidates, { baseUrl: feed.baseUrl, allowedHosts: feed.allowedHosts });
    const policy = assessCapture({
      candidateCount: candidates.length,
      normalizedCount: normalized.records.length,
      rejectedCount: normalized.rejected.length,
      previousCount: feed.lastItemCount,
      capturedAt,
      feed
    });
    // Durable bytes land on the content-addressed store before any SQLite write,
    // so a multi-megabyte response never passes through the capture transaction.
    // A crash here leaves only an unreferenced temp/file for the reconciler.
    const storedAt = this.clock().toISOString();
    const blob = this.blobs.store(html);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const captureId = this.captures.create({
        feedId,
        fingerprint,
        capturedAt,
        accepted: policy.accepted,
        candidateCount: candidates.length,
        normalizedCount: normalized.records.length,
        rejectedCount: normalized.rejected.length,
        duplicateCount: normalized.duplicateCount,
        reason: policy.reason
      });
      this.sources.attachBlob({
        contentHash: fingerprint,
        shardPath: blob.shardPath,
        byteSize: blob.byteSize,
        storedAt
      });
      this.sources.recordSource({
        captureId,
        contentHash: fingerprint,
        parserVersion: PARSER_VERSION,
        byteSize: blob.byteSize,
        storedAt
      });
      if (policy.accepted) {
        this.articles.recordCapture(captureId, feed, normalized.records, capturedAt);
        this.feeds.markAccepted(feedId, capturedAt, normalized.records.length);
      }
      this.database.exec("COMMIT");
      return {
        captureId,
        feedId,
        fingerprint,
        capturedAt,
        accepted: policy.accepted,
        replay: false,
        candidateCount: candidates.length,
        normalizedCount: normalized.records.length,
        rejectedCount: normalized.rejected.length,
        duplicateCount: normalized.duplicateCount,
        reason: policy.reason,
        rejected: normalized.rejected,
        stats: this.articles.stats(feedId),
        source: {
          parserVersion: PARSER_VERSION,
          byteSize: blob.byteSize,
          contentHash: fingerprint,
          reused: blob.reused
        }
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.releaseOrphanBlob(fingerprint);
      throw error;
    }
  }

  releaseOrphanBlob(contentHash) {
    // Runs outside any transaction: the blob may be legitimately shared with
    // another committed capture, so delete the file only when nothing references it.
    if (this.sources.blob(contentHash)) return;
    this.blobs.delete(contentHash);
  }
}
