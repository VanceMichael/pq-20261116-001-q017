import { extractLinks, pageFingerprint, PARSER_VERSION } from "../feed/html.js";
import { normalizeCandidates } from "../feed/normalize.js";
import { validateFeedId } from "../store/feed-repository.js";

export class ReplayService {
  constructor({ feeds, captures, sources, blobs }) {
    this.feeds = feeds;
    this.captures = captures;
    this.sources = sources;
    this.blobs = blobs;
  }

  replay(feedId, captureId) {
    validateFeedId(feedId);
    const feed = this.feeds.get(feedId);
    if (!feed) throw new Error(`unknown feed: ${feedId}`);
    if (!Number.isSafeInteger(captureId) || captureId < 1) {
      throw new TypeError("captureId must be a positive integer");
    }
    if (!this.captures.belongsToFeed(feedId, captureId)) {
      throw Object.assign(new Error(`capture ${captureId} was not found for feed ${feedId}`), {
        code: "capture_not_found", statusCode: 404
      });
    }
    const capture = this.captures.get(captureId);
    const source = this.sources.sourceForCapture(captureId);
    if (!source) {
      throw Object.assign(new Error(`no stored page source for capture ${captureId}`), {
        code: "source_missing", statusCode: 409
      });
    }
    // Reads bytes through the content-addressed path and verifies the digest on load;
    // nothing below this line performs a database write.
    const html = this.blobs.read(source.contentHash);
    const currentFingerprint = pageFingerprint(html);
    if (currentFingerprint !== capture.fingerprint) {
      throw Object.assign(new Error(`replay fingerprint mismatch for capture ${captureId}`), {
        code: "source_mismatch", statusCode: 500
      });
    }
    const candidates = extractLinks(html, feed.baseUrl);
    const normalized = normalizeCandidates(candidates, {
      baseUrl: feed.baseUrl,
      allowedHosts: feed.allowedHosts
    });
    return {
      captureId,
      feedId,
      capturedAt: capture.capturedAt,
      replay: true,
      recorded: {
        accepted: capture.accepted,
        reason: capture.reason,
        fingerprint: capture.fingerprint,
        candidateCount: capture.candidateCount,
        normalizedCount: capture.normalizedCount,
        rejectedCount: capture.rejectedCount,
        duplicateCount: capture.duplicateCount,
        parserVersion: source.parserVersion
      },
      current: {
        parserVersion: PARSER_VERSION,
        parserChanged: source.parserVersion !== PARSER_VERSION,
        fingerprint: currentFingerprint,
        candidateCount: candidates.length,
        normalizedCount: normalized.records.length,
        rejectedCount: normalized.rejected.length,
        duplicateCount: normalized.duplicateCount,
        records: normalized.records,
        rejected: normalized.rejected
      },
      source: {
        contentHash: source.contentHash,
        shardPath: this.blobs.shardPath(source.contentHash),
        byteSize: source.byteSize,
        storedAt: source.storedAt
      }
    };
  }

  rawSource(feedId, captureId) {
    validateFeedId(feedId);
    if (!this.feeds.get(feedId)) throw new Error(`unknown feed: ${feedId}`);
    if (!Number.isSafeInteger(captureId) || captureId < 1) {
      throw new TypeError("captureId must be a positive integer");
    }
    const source = this.sources.sourceForFeedCapture(feedId, captureId);
    if (!source) {
      throw Object.assign(new Error(`no stored page source for capture ${captureId}`), {
        code: "source_missing", statusCode: 404
      });
    }
    const html = this.blobs.read(source.contentHash);
    const capture = this.captures.get(captureId);
    return {
      html,
      contentHash: source.contentHash,
      byteSize: source.byteSize,
      parserVersion: source.parserVersion,
      storedAt: source.storedAt,
      capturedAt: capture?.capturedAt ?? null,
      accepted: capture?.accepted ?? null
    };
  }
}
