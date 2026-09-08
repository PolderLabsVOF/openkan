// tests/env-var-config.test.mts — regression tests for env-var-driven
// HTTP host/port configuration.
//
// Tests:
// a. OPENKAN_PORT and OPENKAN_HOST override .ok/openkan.json values
// b. Invalid OPENKAN_PORT throws
// c. Non-loopback OPENKAN_HOST throws

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "openkan-env-test-"));
}

function rmTmp(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

describe("env-var-config", () => {
  describe("loadConfig with env vars", () => {
    it("env vars override .ok/openkan.json values", async () => {
      const dir = tmpDir();
      try {
        // Create .ok directory and openkan.json with different values
        const okDir = join(dir, ".ok");
        mkdirSync(okDir, { recursive: true });
        const configPath = join(okDir, "openkan.json");
        writeFileSync(configPath, JSON.stringify({ port: 8888, host: "::1" }), "utf-8");

        // Change to the temp directory
        const originalCwd = process.cwd();
        process.chdir(dir);

        // Save and set env vars to override
        const savedPort = process.env.OPENKAN_PORT;
        const savedHost = process.env.OPENKAN_HOST;
        process.env.OPENKAN_PORT = "41888";
        process.env.OPENKAN_HOST = "127.0.0.1";

        try {
          // Re-import to get fresh module state
          const { loadConfig } = await import("../ok/commands/serve.ts");
          const cfg = loadConfig();

          assert.equal(cfg.port, 41888, "port should be overridden by env var");
          assert.equal(cfg.host, "127.0.0.1", "host should be overridden by env var");
        } finally {
          // Restore env vars
          if (savedPort !== undefined) {
            process.env.OPENKAN_PORT = savedPort;
          } else {
            delete process.env.OPENKAN_PORT;
          }
          if (savedHost !== undefined) {
            process.env.OPENKAN_HOST = savedHost;
          } else {
            delete process.env.OPENKAN_HOST;
          }
          process.chdir(originalCwd);
        }
      } finally { rmTmp(dir); }
    });

    it("OPENKAN_PORT=notanumber throws", async () => {
      const dir = tmpDir();
      try {
        const originalCwd = process.cwd();
        process.chdir(dir);

        const savedPort = process.env.OPENKAN_PORT;
        process.env.OPENKAN_PORT = "notanumber";

        try {
          const { loadConfig } = await import("../ok/commands/serve.ts");
          assert.throws(
            () => loadConfig(),
            /OPENKAN_PORT must be an integer between 1 and 65535/,
            "should throw on invalid port"
          );
        } finally {
          if (savedPort !== undefined) {
            process.env.OPENKAN_PORT = savedPort;
          } else {
            delete process.env.OPENKAN_PORT;
          }
          process.chdir(originalCwd);
        }
      } finally { rmTmp(dir); }
    });

    it("OPENKAN_HOST=evil.example throws (non-loopback rejected)", async () => {
      const dir = tmpDir();
      try {
        const originalCwd = process.cwd();
        process.chdir(dir);

        const savedHost = process.env.OPENKAN_HOST;
        process.env.OPENKAN_HOST = "evil.example";

        try {
          const { loadConfig } = await import("../ok/commands/serve.ts");
          assert.throws(
            () => loadConfig(),
            /OPENKAN_HOST must be a loopback address/,
            "should throw on non-loopback host"
          );
        } finally {
          if (savedHost !== undefined) {
            process.env.OPENKAN_HOST = savedHost;
          } else {
            delete process.env.OPENKAN_HOST;
          }
          process.chdir(originalCwd);
        }
      } finally { rmTmp(dir); }
    });
  });
});
