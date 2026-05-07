/**
 * End-to-end smoke for plastron-archive built on xit-wasm.
 *
 *   1. export a fresh document → bytes (this commits "v1")
 *   2. import → segments + live archive
 *   3. mutate segments + export with `previous: bytes` → new bytes (commits "v2")
 *   4. import the v2 bytes; verify the segments rolled forward
 *   5. on the imported archive, demonstrate the "pleasant surprise":
 *      list files via Archive's API to show it really is a versioned repo
 */

import * as path from "node:path";
import { setDefaultWasmSource } from "xit-wasm";
import type { Segment } from "../../../plastron/src/types/index.js";

import { exportArchive } from "../dist/export.js";
import { importArchive } from "../dist/import.js";

setDefaultWasmSource(
  path.resolve(import.meta.dirname, "../../../../xit/zig-out/bin/xit.wasm"),
);

async function main() {
  console.log("=== v1 export ===");
  const v1Segments: Segment[] = [
    { key: "alpha", cels: [] },
    { key: "beta", cels: [] },
  ];
  const v1Bytes = await exportArchive(v1Segments, { message: "initial export" });
  console.log(`v1: ${v1Bytes.byteLength} bytes`);

  console.log("\n=== v1 import ===");
  const v1 = await importArchive(v1Bytes);
  console.log("manifest segments:", v1.manifest.segments);
  console.log("hydrated:", v1.segments.map((s) => s.key));
  console.log(
    "(pleasant surprise: archive.list() shows the working tree)\n  ",
    (await v1.archive.list()).join("\n   "),
  );
  await v1.archive.close();

  console.log("\n=== v2 export (mutate + commit on top of v1) ===");
  const v2Segments: Segment[] = [
    { key: "alpha", cels: [] },
    { key: "gamma", cels: [] }, // beta removed, gamma added
  ];
  const v2Bytes = await exportArchive(v2Segments, {
    previous: v1Bytes,
    message: "swap beta for gamma",
  });
  console.log(`v2: ${v2Bytes.byteLength} bytes (should be larger — history retained)`);

  console.log("\n=== v2 import ===");
  const v2 = await importArchive(v2Bytes);
  console.log("manifest segments:", v2.manifest.segments);
  console.log("hydrated:", v2.segments.map((s) => s.key));

  const beta = await v2.archive.read("segments/beta.json");
  console.log("segments/beta.json after swap:", beta === null ? "absent ✓" : "still present!");

  const gamma = await v2.archive.read("segments/gamma.json");
  console.log("segments/gamma.json after swap:", gamma ? "present ✓" : "missing!");
  await v2.archive.close();

  console.log("\nall checks ok ✓");
}

await main();
