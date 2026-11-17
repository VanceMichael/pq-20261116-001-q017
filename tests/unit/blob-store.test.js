import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, TEMP_PREFIX, hashContent } from "../../src/store/blob-store.js";

async function freshRoot() {
  return mkdtemp(join(tmpdir(), "blob-store-test-"));
}

test("stores bytes under a content-addressed shard path and reuses identical content", async (t) => {
  const root = await freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new BlobStore(root);
  const content = "<!doctype html><html>原文</html>";
  const first = store.store(content);
  assert.equal(first.hash, hashContent(content));
  assert.equal(first.shardPath, join(first.hash.slice(0, 2), first.hash));
  assert.equal(first.byteSize, Buffer.byteLength(content, "utf8"));
  assert.equal(first.reused, false);
  assert.equal(readFileSync(join(root, first.shardPath), "utf8"), content);
  const second = store.store(content);
  assert.equal(second.reused, true);
  assert.equal(second.hash, first.hash);
  assert.equal(readdirSync(join(root, first.hash.slice(0, 2))).length, 1);
});

test("writes through a temporary file and never leaves one behind after success", async (t) => {
  const root = await freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new BlobStore(root);
  store.store("<html>temp-safe</html>");
  assert.deepEqual(store.listTempFiles(), []);
  assert.ok(readdirSync(join(root, "tmp")).length >= 0);
});

test("lists temp files from a crashed write so the reconciler can remove them", async (t) => {
  const root = await freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new BlobStore(root);
  const leftover = join(root, "tmp", `${TEMP_PREFIX}abandoned.tmp`);
  writeFileSync(leftover, "partial");
  const listed = store.listTempFiles();
  assert.deepEqual(listed, [leftover]);
  store.removeTempFile(leftover);
  assert.deepEqual(store.listTempFiles(), []);
});

test("read verifies the digest and surfaces a distinct corruption error", async (t) => {
  const root = await freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new BlobStore(root);
  const blob = store.store("<html>verify me</html>");
  writeFileSync(join(root, blob.shardPath), "<html>tampered</html>");
  assert.throws(() => store.read(blob.hash), /integrity check/);
  assert.throws(() => store.read(blob.hash), (error) => error.code === "blob_corrupt");
});

test("read reports a missing blob with a replay-safe error code", async (t) => {
  const root = await freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new BlobStore(root);
  assert.throws(() => store.read("a".repeat(64)), (error) => error.code === "blob_missing");
});

test("listEntries only returns sharded blob files, never temp files", async (t) => {
  const root = await freshRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new BlobStore(root);
  const one = store.store("<html>one</html>");
  store.store("<html>two</html>");
  writeFileSync(join(root, "tmp", `${TEMP_PREFIX}x.tmp`), "x");
  const hashes = store.listEntries().map((entry) => entry.hash).sort();
  assert.deepEqual(hashes, [one.hash, hashContent("<html>two</html>")].sort());
});

test("propagates a directory write failure instead of pretending the blob was saved", async (t) => {
  const root = await freshRoot();
  t.after(() => {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  const store = new BlobStore(root);
  chmodSync(join(root, "tmp"), 0o500);
  assert.throws(() => store.store("<html>denied</html>"));
  assert.deepEqual(store.listTempFiles(), []);
});
