// tests/cli-migration.test.mts — regression gate guarding the bin/openkan.ts
// absence after the M1 CLI relocation landed. The full invariant suite
// (more bin/ok.ts absence and namespace gates) is owned by M4; this M1 copy
// exists so the gap between M1 and M4 cannot lose the bin/openkan.ts
// deletion to a sloppy revert.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";

test("bin/openkan.ts is gone after OK migration", () => {
  assert.equal(existsSync("bin/openkan.ts"), false);
});
