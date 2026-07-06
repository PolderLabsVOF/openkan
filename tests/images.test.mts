// tests/images.test.mts — unit tests for kanban/images.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveImage, listImages, deleteImage, readImage, imagesDir, ensureImagesDir } from "../kanban/images.ts";

describe("images", () => {
  let tmp: string;
  let taskId: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `images-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    taskId = `tsk-${Date.now()}`;
    mkdirSync(join(tmp, "tasks", taskId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { force: true, recursive: true });
  });

  describe("saveImage + listImages", () => {
    it("saves a PNG image and lists it", () => {
      const buf = Buffer.from("fake-png-data");
      const meta = saveImage(taskId, tmp, buf, "png", "image/png", "alice");
      assert.ok(meta.name.endsWith(".png"));
      assert.strictEqual(meta.taskId, taskId);
      assert.strictEqual(meta.size, buf.length);
      assert.strictEqual(meta.contentType, "image/png");
      assert.strictEqual(meta.uploadedBy, "alice");
      assert.ok(meta.uploadedAt);

      const all = listImages(taskId, tmp);
      assert.ok(all.some(x => x.name === meta.name));
    });

    it("saves a JPEG image with jpg extension", () => {
      const buf = Buffer.from("fake-jpg-data");
      const meta = saveImage(taskId, tmp, buf, "jpg", "image/jpeg", "bob");
      assert.ok(meta.name.endsWith(".jpg"));
      assert.strictEqual(meta.contentType, "image/jpeg");
    });

    it("saves a GIF image", () => {
      const buf = Buffer.from("fake-gif-data");
      const meta = saveImage(taskId, tmp, buf, "gif", "image/gif", "carol");
      assert.ok(meta.name.endsWith(".gif"));
    });

    it("saves a WebP image", () => {
      const buf = Buffer.from("fake-webp-data");
      const meta = saveImage(taskId, tmp, buf, "webp", "image/webp", "dave");
      assert.ok(meta.name.endsWith(".webp"));
    });

    it("saves an SVG image", () => {
      const buf = Buffer.from("fake-svg-data");
      const meta = saveImage(taskId, tmp, buf, "svg", "image/svg+xml", "erin");
      assert.ok(meta.name.endsWith(".svg"));
      assert.strictEqual(meta.contentType, "image/svg+xml");
    });

    it("saves with jpeg extension and image/jpeg content type", () => {
      const buf = Buffer.from("fake-jpeg-data");
      const meta = saveImage(taskId, tmp, buf, "jpeg", "image/jpeg", "frank");
      assert.ok(meta.name.endsWith(".jpeg"));
    });

    it("stores the file on disk", async () => {
      const buf = Buffer.from("on-disk-test");
      const meta = saveImage(taskId, tmp, buf, "png", "image/png", "grace");
      const imgDir = imagesDir(taskId, tmp);
      const filePath = join(imgDir, meta.name);
      const { existsSync: exists, readFileSync: read } = await import("node:fs");
      assert.ok(exists(filePath));
      assert.strictEqual(read(filePath, "utf-8"), "on-disk-test");
    });

    it("records entry in images.json", () => {
      const buf = Buffer.from("store-test");
      const meta = saveImage(taskId, tmp, buf, "png", "image/png", "henry");
      const all = listImages(taskId, tmp);
      const found = all.find(x => x.name === meta.name);
      assert.ok(found);
      assert.strictEqual(found!.uploadedBy, "henry");
    });
  });

  describe("saveImage validation", () => {
    it("rejects invalid extension", () => {
      const buf = Buffer.from("test");
      assert.throws(
        () => saveImage(taskId, tmp, buf, "exe", "application/octet-stream", "user"),
        /Invalid file extension/,
      );
    });

    it("rejects pdf extension", () => {
      const buf = Buffer.from("test");
      assert.throws(
        () => saveImage(taskId, tmp, buf, "pdf", "application/pdf", "user"),
        /Invalid file extension/,
      );
    });

    it("rejects file larger than 10 MB", () => {
      // 10 MB + 1 byte
      const buf = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
      assert.throws(
        () => saveImage(taskId, tmp, buf, "png", "image/png", "user"),
        /File too large/,
      );
    });

    it("accepts exactly 10 MB", () => {
      const buf = Buffer.alloc(10 * 1024 * 1024, 0);
      const meta = saveImage(taskId, tmp, buf, "png", "image/png", "user");
      assert.ok(meta.name.endsWith(".png"));
    });

    it("accepts uppercase extension (normalizes to lowercase)", () => {
      const buf = Buffer.from("uppercase-ext");
      const meta = saveImage(taskId, tmp, buf, "PNG", "image/png", "user");
      assert.ok(meta.name.endsWith(".png"));
    });
  });

  describe("deleteImage", () => {
    it("deletes an existing image", () => {
      const buf = Buffer.from("to-delete");
      const meta = saveImage(taskId, tmp, buf, "png", "image/png", "iris");
      const ok = deleteImage(taskId, tmp, meta.name);
      assert.strictEqual(ok, true);

      const all = listImages(taskId, tmp);
      assert.ok(!all.some(x => x.name === meta.name));
    });

    it("returns false for non-existent image", () => {
      const ok = deleteImage(taskId, tmp, "nonexistent.png");
      assert.strictEqual(ok, false);
    });
  });

  describe("readImage", () => {
    it("round-trips written bytes correctly", () => {
      const original = Buffer.from("round-trip-test-data");
      const meta = saveImage(taskId, tmp, original, "png", "image/png", "jack");

      const result = readImage(taskId, tmp, meta.name);
      assert.ok(result);
      assert.strictEqual(result.contentType, "image/png");
      assert.deepStrictEqual(result.buffer, original);
    });

    it("returns null for non-existent image", () => {
      const result = readImage(taskId, tmp, "does-not-exist.png");
      assert.strictEqual(result, null);
    });
  });

  describe("ensureImagesDir", () => {
    it("creates the images directory if missing", async () => {
      const dir = ensureImagesDir(taskId, tmp);
      assert.ok(dir.endsWith("images"));
      const { existsSync: exists } = await import("node:fs");
      assert.ok(exists(dir));
    });

    it("returns the same path on subsequent calls", () => {
      const dir1 = ensureImagesDir(taskId, tmp);
      const dir2 = ensureImagesDir(taskId, tmp);
      assert.strictEqual(dir1, dir2);
    });
  });
});
