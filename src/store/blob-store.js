import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, writeSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const TEMP_PREFIX = ".tmp-";

export function hashContent(content, algorithm = "sha256") {
  return createHash(algorithm).update(content, "utf8").digest("hex");
}

export class BlobStore {
  constructor(root, { algorithm = "sha256" } = {}) {
    if (typeof root !== "string" || root.length === 0) throw new TypeError("blob root directory is required");
    this.root = resolve(root);
    this.algorithm = algorithm;
    this.tempDir = join(this.root, "tmp");
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.tempDir, { recursive: true });
  }

  hash(content) {
    return hashContent(content, this.algorithm);
  }

  shardPath(hash) {
    return join(hash.slice(0, 2), hash);
  }

  absolutePath(hash) {
    return join(this.root, this.shardPath(hash));
  }

  store(content) {
    if (typeof content !== "string" || content.length === 0) {
      throw new TypeError("blob content must be a non-empty string");
    }
    const hash = this.hash(content);
    const byteSize = Buffer.byteLength(content, "utf8");
    const shard = this.shardPath(hash);
    const target = this.absolutePath(hash);
    if (existsSync(target)) return { hash, byteSize, shardPath: shard, reused: true };
    mkdirSync(dirname(target), { recursive: true });
    const tempPath = join(this.tempDir, `${TEMP_PREFIX}${randomUUID()}.tmp`);
    const fd = openSync(tempPath, "wx");
    try {
      writeSync(fd, content, null, "utf8");
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      rmSync(tempPath, { force: true });
      throw error;
    }
    closeSync(fd);
    renameSync(tempPath, target);
    return { hash, byteSize, shardPath: shard, reused: false };
  }

  exists(hash) {
    return existsSync(this.absolutePath(hash));
  }

  read(hash) {
    const target = this.absolutePath(hash);
    if (!existsSync(target)) {
      throw Object.assign(new Error(`stored page source is missing: ${hash}`), {
        code: "blob_missing", statusCode: 409
      });
    }
    const content = readFileSync(target, "utf8");
    if (this.hash(content) !== hash) {
      throw Object.assign(new Error(`stored page source failed integrity check: ${hash}`), {
        code: "blob_corrupt", statusCode: 500
      });
    }
    return content;
  }

  delete(hash) {
    return rmSync(this.absolutePath(hash), { force: true });
  }

  listEntries() {
    const entries = [];
    for (const shard of safeReaddir(this.root)) {
      if (shard.name === "tmp" || !shard.isDirectory()) continue;
      const shardDir = join(this.root, shard.name);
      for (const file of safeReaddir(shardDir)) {
        if (file.isFile()) entries.push({ hash: file.name, shardPath: join(shard.name, file.name) });
      }
    }
    return entries;
  }

  listTempFiles() {
    return safeReaddir(this.tempDir)
      .filter((entry) => entry.isFile() && entry.name.startsWith(TEMP_PREFIX))
      .map((entry) => join(this.tempDir, entry.name));
  }

  removeTempFile(path) {
    return rmSync(path, { force: true });
  }
}

function safeReaddir(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true });
}
