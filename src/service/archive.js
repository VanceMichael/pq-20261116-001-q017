import { dirname, join } from "node:path";
import { openDatabase, closeDatabase } from "../store/database.js";
import { FeedRepository } from "../store/feed-repository.js";
import { CaptureRepository } from "../store/capture-repository.js";
import { ArticleRepository } from "../store/article-repository.js";
import { FetchRepository } from "../store/fetch-repository.js";
import { PageSourceRepository } from "../store/page-source-repository.js";
import { BlobStore } from "../store/blob-store.js";
import { ImportService } from "../ingest/import-service.js";
import { PageFetcher } from "../acquisition/page-fetcher.js";
import { RefreshService } from "./refresh-service.js";
import { ChangeReportService } from "./change-report.js";
import { HealthReportService } from "./health-report.js";
import { ReviewRepository } from "../store/review-repository.js";
import { ReviewService } from "./review-service.js";
import { CsvExporter } from "../export/csv-exporter.js";
import { ArticleTimelineService } from "./article-timeline.js";
import { IntegrityAuditService } from "./integrity-audit.js";
import { ReplayService } from "./replay-service.js";
import { BlobReconcileService } from "./blob-reconcile-service.js";

export class NewsArchive {
  constructor(filename, options = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.database = openDatabase(filename);
    const blobRoot = options.blobRoot ?? join(dirname(filename), "blobs");
    this.blobs = options.blobStore ?? new BlobStore(blobRoot);
    this.feeds = new FeedRepository(this.database);
    this.captures = new CaptureRepository(this.database);
    this.articles = new ArticleRepository(this.database);
    this.fetches = new FetchRepository(this.database);
    this.reviews = new ReviewRepository(this.database);
    this.sources = new PageSourceRepository(this.database);
    this.imports = new ImportService({
      database: this.database,
      feeds: this.feeds,
      captures: this.captures,
      articles: this.articles,
      sources: this.sources,
      blobs: this.blobs,
      clock: this.clock
    });
    this.refreshes = new RefreshService({
      feeds: this.feeds,
      fetches: this.fetches,
      fetcher: options.fetcher ?? new PageFetcher(),
      imports: this.imports,
      clock: this.clock
    });
    this.changes = new ChangeReportService({ feeds: this.feeds, captures: this.captures, articles: this.articles });
    this.health = new HealthReportService({ feeds: this.feeds, fetches: this.fetches, clock: this.clock });
    this.reviewService = new ReviewService({ feeds: this.feeds, reviews: this.reviews, clock: this.clock });
    this.csvExporter = new CsvExporter({ database: this.database, feeds: this.feeds, articles: this.articles });
    this.timelines = new ArticleTimelineService({ feeds: this.feeds, reviews: this.reviews, articles: this.articles });
    this.integrityAudit = new IntegrityAuditService(this.database, { blobs: this.blobs, sources: this.sources });
    this.replay = new ReplayService({
      feeds: this.feeds,
      captures: this.captures,
      sources: this.sources,
      blobs: this.blobs
    });
    this.reconciler = new BlobReconcileService({ blobs: this.blobs, sources: this.sources, clock: this.clock });
    // Recover from a half-finished save on a previous process before serving traffic.
    this.lastReconciliation = this.reconciler.sweep();
  }

  registerFeed(input) {
    return this.feeds.register(input, this.now());
  }

  importSnapshot(feedId, html, capturedAt) {
    return this.imports.importHtml(feedId, html, capturedAt);
  }

  refreshFeed(feedId) {
    return this.refreshes.refresh(feedId);
  }

  feedStatus(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) return null;
    const latest = this.captures.recent(feedId, 1)[0] ?? null;
    return {
      ...feed,
      health: latest ? latest.accepted ? "healthy" : "degraded" : "awaiting_capture",
      latestAttempt: latest,
      statistics: this.articles.stats(feedId),
      collectionHealth: this.health.report(feedId)
    };
  }

  listItems(feedId, options) {
    if (!this.feeds.get(feedId)) return null;
    return { items: this.articles.list(feedId, options), statistics: this.articles.stats(feedId) };
  }

  listCaptures(feedId, limit) {
    if (!this.feeds.get(feedId)) return null;
    return this.captures.recent(feedId, limit);
  }

  listFetchAttempts(feedId, limit) {
    return this.refreshes.recent(feedId, limit);
  }

  feedChanges(feedId) {
    return this.changes.report(feedId);
  }

  feedHealth(feedId) {
    return this.health.report(feedId);
  }

  reviewArticle(feedId, articleId, input) {
    return this.reviewService.change(feedId, articleId, input);
  }

  reviewEvents(feedId, articleId, limit) {
    return this.reviewService.events(feedId, articleId, limit);
  }

  exportCsv(feedId, writable, options) {
    return this.csvExporter.write(feedId, writable, options);
  }

  articleTimeline(feedId, articleId, limit) {
    return this.timelines.report(feedId, articleId, limit);
  }

  auditIntegrity() {
    return this.integrityAudit.run();
  }

  replayCapture(feedId, captureId) {
    return this.replay.replay(feedId, captureId);
  }

  captureSource(feedId, captureId) {
    return this.replay.rawSource(feedId, captureId);
  }

  reconcileBlobs() {
    this.lastReconciliation = this.reconciler.sweep();
    return this.lastReconciliation;
  }

  close() {
    closeDatabase(this.database);
  }

  now() {
    return this.clock().toISOString();
  }
}
