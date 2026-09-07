// tests/board-corruption.test.mts — board.json corruption recovery.
//
// Regression for: starting the server with a malformed board.json surfaced
// as the opaque "board.tasks is not iterable" crash. The loader now recovers
// from structured-but-broken shapes (missing/non-array `tasks` or `columns`,
// or root not an object) but still fails loudly when JSON itself cannot parse,
// because that means the file is genuinely damaged.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We import the module under test directly so its exports are stable; this
// matches the project's pattern of calling internal helpers from tests.
import { readBoardSafe } from "../kanban/board.ts";

let dir: string;
let boardPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ok-board-corruption-"));
  boardPath = join(dir, "board.json");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeBoard(payload: string | unknown): void {
  writeFileSync(
    boardPath,
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    "utf-8",
  );
}

describe("readBoardSafe recovery", () => {
  it("returns the parsed board unchanged when the file is well-formed", () => {
    const good = {
      version: 1,
      columns: [{ id: "backlog", title: "Backlog" }],
      tasks: [{ id: "tsk-x", title: "demo" }],
      sessions: {},
    };
    writeBoard(good);
    const { board, recovered } = readBoardSafe(boardPath);
    assert.equal(recovered, false);
    assert.equal(board.tasks[0].id, "tsk-x");
    assert.equal(board.columns[0].id, "backlog");
  });

  it("recovers when tasks is missing", () => {
    writeBoard({ version: 1, columns: [], sessions: {} });
    const { board, recovered } = readBoardSafe(boardPath);
    assert.equal(recovered, true);
    assert.deepEqual(board.tasks, []);
    assert.ok(board.columns.length > 0, "default columns seeded");
  });

  it("recovers when tasks is not an array (e.g. {\"a\":2})", () => {
    writeBoard({ a: 2 });
    const { board, recovered } = readBoardSafe(boardPath);
    assert.equal(recovered, true);
    assert.ok(Array.isArray(board.tasks));
    assert.ok(Array.isArray(board.columns));
    assert.ok(board.columns.length > 0);
  });

  it("recovers when columns is missing", () => {
    writeBoard({ version: 1, tasks: [], sessions: {} });
    const { board, recovered } = readBoardSafe(boardPath);
    assert.equal(recovered, true);
    assert.ok(board.columns.length > 0);
  });

  it("recovers when root is not an object", () => {
    // Bare value that parses as JSON but is a primitive, not an object.
    writeBoard("42");
    const { board, recovered } = readBoardSafe(boardPath);
    assert.equal(recovered, true);
    assert.ok(Array.isArray(board.tasks));
    assert.ok(Array.isArray(board.columns));
    assert.ok(board.columns.length > 0);
  });

  it("throws SyntaxError when JSON itself is unparseable", () => {
    writeBoard("{not json");
    assert.throws(() => readBoardSafe(boardPath), /JSON|Unexpected/i);
  });

  it("keeps the on-disk file untouched when shape is recoverable", () => {
    // Recovery must not silently rewrite the file: the loader is read-only.
    writeBoard({ a: 2 });
    readBoardSafe(boardPath);
    const onDisk = JSON.parse(readFileSync(boardPath, "utf-8"));
    assert.deepEqual(onDisk, { a: 2 });
  });
});
