import { test, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// Attempt to set a root before the kernel module loads. When this
// file is the first test to import dist, the env override takes
// effect; when an earlier file has already imported dist (multi-file
// `bun test` run), the singleton is already bound to the default and
// our override is ignored. Either way, isolate this suite's files
// under a unique prefix inside whatever root the segment chose so the
// suite is robust to import order.
process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs";

const { createInitialState, resolveFn } = await import("../dist/index.js");

const TEST_PREFIX = `__fst-test-${process.pid}-${Date.now().toString(36)}`;
const p = (rel) => `${TEST_PREFIX}/${rel}`;

let state;
let activeRoot;
beforeAll(async () => {
  state = createInitialState();
  activeRoot = state.cels.get("file-store.root").v;
  // Wipe any stale subtree from a prior run that shared this root.
  await fs.rm(path.resolve(activeRoot, TEST_PREFIX), { recursive: true, force: true });
});
afterAll(async () => {
  if (activeRoot) {
    await fs.rm(path.resolve(activeRoot, TEST_PREFIX), { recursive: true, force: true });
  }
});

const call = (key, ...args) => resolveFn(state, key)(...args);

// ----- Capability + descriptor cels -----

test("backend descriptor cels reflect the active singleton (node-fs in CLI)", () => {
  assert.equal(state.cels.get("file-store.node-fs-available").v, true);
  assert.equal(state.cels.get("file-store.opfs-available").v, false);
  assert.equal(state.cels.get("file-store.backend").v, "node-fs");
  // Root is whichever PLASTRON_FILE_STORE_ROOT was set when the module
  // first loaded — could be our override or the `./.plastron-fs`
  // default depending on test import order. Assert non-empty string
  // shape, not the specific value.
  const root = state.cels.get("file-store.root").v;
  assert.equal(typeof root, "string");
  assert.notEqual(root, "");
});

// ----- write / read / readText / writeText -----

test("write + read round-trip on bytes", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  await call("fs.write", p("round/bytes.bin"), bytes);
  const got = await call("fs.read", p("round/bytes.bin"));
  assert.ok(got instanceof Uint8Array);
  assert.deepEqual([...got], [1, 2, 3, 4, 5]);
});

test("writeText + readText round-trip", async () => {
  await call("fs.writeText", p("round/note.txt"), "Hello, plastron");
  assert.equal(await call("fs.readText", p("round/note.txt")), "Hello, plastron");
});

test("fs.write accepts a string and stores its UTF-8 bytes", async () => {
  await call("fs.write", p("round/string.txt"), "héllo");
  const bytes = await call("fs.read", p("round/string.txt"));
  assert.deepEqual([...bytes], [...new TextEncoder().encode("héllo")]);
});

test("fs.write auto-creates missing parent directories", async () => {
  await call("fs.write", p("auto/parent/dirs/file.txt"), "ok");
  assert.equal(await call("fs.readText", p("auto/parent/dirs/file.txt")), "ok");
});

test("fs.write overwrites in place", async () => {
  await call("fs.writeText", p("round/over.txt"), "first");
  await call("fs.writeText", p("round/over.txt"), "second");
  assert.equal(await call("fs.readText", p("round/over.txt")), "second");
});

// ----- exists / stat / list -----

test("fs.exists returns true for present and false for missing", async () => {
  await call("fs.writeText", p("probe/present.txt"), "x");
  assert.equal(await call("fs.exists", p("probe/present.txt")), true);
  assert.equal(await call("fs.exists", p("probe/absent.txt")), false);
});

test("fs.stat reports size, isDir, and mtime for a file", async () => {
  await call("fs.writeText", p("stat/file.txt"), "Hello");
  const s = await call("fs.stat", p("stat/file.txt"));
  assert.equal(s.size, 5);
  assert.equal(s.isDir, false);
  assert.equal(typeof s.mtime, "number");
});

test("fs.stat reports isDir=true for a directory", async () => {
  await call("fs.mkdir", p("stat/dir"));
  const s = await call("fs.stat", p("stat/dir"));
  assert.equal(s.isDir, true);
});

test("fs.list returns child names only (no slashes)", async () => {
  await call("fs.mkdir", p("list"));
  await call("fs.writeText", p("list/a.txt"), "a");
  await call("fs.writeText", p("list/b.txt"), "b");
  await call("fs.mkdir", p("list/sub"));
  const names = await call("fs.list", p("list"));
  assert.deepEqual(names.sort(), ["a.txt", "b.txt", "sub"]);
  for (const n of names) assert.equal(n.includes("/"), false);
});

// ----- mkdir / rmdir / delete -----

test("fs.mkdir is recursive by default and idempotent", async () => {
  await call("fs.mkdir", p("mk/a/b/c"));
  await call("fs.mkdir", p("mk/a/b/c")); // idempotent — does not throw
  assert.equal(await call("fs.exists", p("mk/a/b/c")), true);
});

test("fs.delete removes a file and is a no-op on missing", async () => {
  await call("fs.writeText", p("del/x.txt"), "bye");
  await call("fs.delete", p("del/x.txt"));
  assert.equal(await call("fs.exists", p("del/x.txt")), false);
  await call("fs.delete", p("del/never.txt")); // no-op
});

test("fs.rmdir removes a directory tree", async () => {
  await call("fs.mkdir", p("tree/one/two"));
  await call("fs.writeText", p("tree/one/file.txt"), "z");
  await call("fs.rmdir", p("tree"));
  assert.equal(await call("fs.exists", p("tree")), false);
});

// ----- rename -----

test("fs.rename moves a file", async () => {
  await call("fs.writeText", p("ren/from.txt"), "hello");
  await call("fs.rename", p("ren/from.txt"), p("ren/to.txt"));
  assert.equal(await call("fs.exists", p("ren/from.txt")), false);
  assert.equal(await call("fs.readText", p("ren/to.txt")), "hello");
});

// ----- Path safety (no prefix — these test the escape guard itself) -----

test("fs.read rejects paths that escape the root", async () => {
  await assert.rejects(
    async () => { await call("fs.read", "../../etc/passwd"); },
    /escapes root/,
  );
});

test("fs.write rejects paths that escape the root", async () => {
  await assert.rejects(
    async () => { await call("fs.write", "ok/../../../boom.txt", "x"); },
    /escapes root/,
  );
});

test("fs.read on a missing file rejects", async () => {
  await assert.rejects(async () => { await call("fs.read", p("missing/file.bin")); });
});

// ----- file-binary schema protocols -----

test("file-binary SchemaCel is installed with the three protocol keys", () => {
  const schema = state.cels.get("file-binary");
  assert.ok(schema, "file-binary cel missing");
  assert.equal(schema.celType, "SchemaCel");
  assert.deepEqual(schema.v.protocols, {
    size: "file-binary_size",
    isChanged: "file-binary_isChanged",
    mime: "file-binary_mime",
  });
});

test("file-binary_size returns byte length for Uint8Array, 0 otherwise", () => {
  const size = resolveFn(state, "file-binary_size");
  assert.equal(size(new Uint8Array([1, 2, 3])), 3);
  assert.equal(size("not bytes"), 0);
  assert.equal(size(null), 0);
});

test("file-binary_isChanged is byte-equal for Uint8Arrays", () => {
  const isChanged = resolveFn(state, "file-binary_isChanged");
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 3]);
  const c = new Uint8Array([1, 2, 4]);
  const d = new Uint8Array([1, 2]);
  assert.equal(isChanged(a, b), false);
  assert.equal(isChanged(a, c), true);
  assert.equal(isChanged(a, d), true);
});

test("file-binary_mime returns the octet-stream default", () => {
  const mime = resolveFn(state, "file-binary_mime");
  assert.equal(mime(new Uint8Array([1])), "application/octet-stream");
});

// ----- Formula-callable: end-to-end via the formula compiler -----

test("fs.* fns are callable from S-expression formulas", async () => {
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");
  const targetPath = p("formula/hello.txt");
  const seg = {
    name: "fs-formula-test",
    cels: [
      {
        key: "fs-test.path",
        celType: "ValueCel",
        metadata: { key: "fs-test.path", segment: "fs-formula-test", v: targetPath },
      },
      {
        key: "fs-test.content",
        celType: "ValueCel",
        metadata: { key: "fs-test.content", segment: "fs-formula-test", v: "Formula said hi" },
      },
      {
        key: "fs-test.write",
        celType: "FormulaCel",
        metadata: {
          key: "fs-test.write", segment: "fs-formula-test", parser: "f",
          inputMap: { "fs.writeText": "fs.writeText", "fs-test.path": "fs-test.path", "fs-test.content": "fs-test.content" },
        },
        f: "(fs.writeText fs-test.path fs-test.content)",
      },
    ],
  };
  const manifest = {
    name: "fs-formula-test", version: "0.0.1",
    description: "exercise fs.* from a formula", dependencies: [],
  };
  await hydrate(state, [seg], [manifest]);
  await runCycle(state);
  // Give the async fs.writeText time to settle, then verify the bytes
  // landed on disk by reading them back through the same fn surface.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await call("fs.readText", targetPath), "Formula said hi");
});
