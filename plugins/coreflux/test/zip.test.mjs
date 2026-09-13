import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { collectFiles, zipDirectory } from "../scripts/mcp/lib/zip.mjs";

/** Minimal ZIP reader: walks the central directory and inflates every entry. */
function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "end of central directory not found");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory signature");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "local header signature");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("zipDirectory produces a readable archive and skips VCS noise", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cf-zip-"));
  try {
    mkdirSync(path.join(dir, "nested"));
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "README.md"), "# Project\n".repeat(200));
    writeFileSync(path.join(dir, "nested", "01-models.lotnb"), JSON.stringify([{ kind: 2, language: "lot", value: 'DEFINE MODEL M WITH TOPIC "m"' }]));
    writeFileSync(path.join(dir, "nested", "random.bin"), Buffer.from([1, 2, 3, 4, 5]));
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    writeFileSync(path.join(dir, "node_modules", "x.js"), "module.exports = 1");

    const files = collectFiles(dir);
    assert.deepEqual(files, ["README.md", "nested/01-models.lotnb", "nested/random.bin"]);

    const { buffer, files: zipped } = zipDirectory(dir);
    assert.deepEqual(zipped, files);
    const entries = readZip(buffer);
    assert.deepEqual([...entries.keys()].sort(), files);
    assert.equal(entries.get("README.md").toString("utf8"), "# Project\n".repeat(200));
    assert.deepEqual([...entries.get("nested/random.bin")], [1, 2, 3, 4, 5]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zipDirectory honours an include filter", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cf-zip-"));
  try {
    writeFileSync(path.join(dir, "keep.lotnb"), "[]");
    writeFileSync(path.join(dir, "drop.txt"), "x");
    const { files } = zipDirectory(dir, { include: (rel) => rel.endsWith(".lotnb") });
    assert.deepEqual(files, ["keep.lotnb"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
