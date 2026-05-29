// ============================================================================
// e2e/scenarios.ts — exhaustive end-to-end coverage against the real browser.
//
// Drives the bundled OS at http://localhost:PORT through Playwright +
// system google-chrome. The file-toolbar's New / Save / Open use
// window.prompt, which is awkward to drive deterministically in a stacked
// dialog flow; instead we click into the apps via icons + textareas + cells
// (the real UX) and invoke the file.* helpers directly via __plastron with a
// name payload (the registered fn signature already supports this for
// scriptability). We still assert the file-toolbar's buttons exist + the
// active doc name shows up — i.e. the *render-side* of those clicks — so the
// toolbar wiring is covered, just not the prompt itself.
//
// Scenarios:
//   1. Home screen renders all four icons.
//   2. Notepad lifecycle — New A → type → Save → New B → type → Save →
//      Open A → edit → Save → Close (Exit) → re-open via the launcher.
//   3. File Explorer lists the user-spaces from (2) and opens them.
//   4. File Explorer + New (programmatic) creates a doc that shows up.
//   5. Sheets — New A → cell edits → Save → New B → edits → Open A restored.
// ============================================================================

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const CHROME_PATH = "/usr/bin/google-chrome";
const HEADLESS = process.env.E2E_HEADFUL !== "1";

// ── tiny assertion helpers ──────────────────────────────────────────────────
let passes = 0, fails = 0;
const ok = (cond: unknown, what: string): void => {
  if (cond) { passes++; console.log(`  ✔ ${what}`); }
  else      { fails++;  console.log(`  ✘ ${what}`); }
};
const eq = (actual: unknown, expected: unknown, what: string): void => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (pass) { passes++; console.log(`  ✔ ${what}`); }
  else      { fails++;  console.log(`  ✘ ${what}\n      actual:   ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`); }
};

// ── browser plumbing ────────────────────────────────────────────────────────
const launch = async (): Promise<Browser> =>
  chromium.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

const newPage = async (browser: Browser, baseURL: string): Promise<{ ctx: BrowserContext; page: Page }> => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Stub window.prompt → always cancel; we drive file ops via callFn so the
  // prompt should not be reached. If it ever is, we cancel so the test fails
  // visibly rather than hanging.
  await ctx.addInitScript(() => { (window as { prompt?: (m: string, d?: string) => string | null }).prompt = () => null; });
  page.on("console", (m) => { if (m.type() === "error") console.log("    [page error]", m.text()); });
  page.on("pageerror", (err) => console.log("    [page exception]", err.message));
  await page.goto(`${baseURL}/index.html`, { waitUntil: "load" });
  await page.waitForSelector('button:has-text("Sheets")', { timeout: 5000 });
  return { ctx, page };
};

// Plastron state probes via the global the entry exposes on window.
const cel = async (page: Page, key: string): Promise<unknown> =>
  page.evaluate((k) => {
    const pl = (window as { __plastron?: { resolveFn: (k: string) => (...x: unknown[]) => unknown; state: unknown } }).__plastron;
    return pl?.resolveFn("get")(pl.state, k);
  }, key);

const callFn = async (page: Page, fnKey: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(async ([k, a]) => {
    const pl = (window as { __plastron?: { resolveFn: (k: string) => (...x: unknown[]) => unknown; state: unknown } }).__plastron!;
    return await pl.resolveFn(k as string)(pl.state, ...(a as unknown[]));
  }, [fnKey, args] as [string, unknown[]]);

// Wait for a cel to reach `expected` (deep-equal); polls every 50 ms.
const waitForCel = async (page: Page, key: string, expected: unknown, ms = 2000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await cel(page, key);
    if (JSON.stringify(v) === JSON.stringify(expected)) return true;
    await page.waitForTimeout(50);
  }
  console.log(`    timeout: ${key} = ${JSON.stringify(await cel(page, key))} (wanted ${JSON.stringify(expected)})`);
  return false;
};

// Replace the textarea's value AND fire input so the cel updates. Playwright's
// .fill() does exactly this (issues 'input' event after setting value).
const typeIntoPad = async (page: Page, text: string): Promise<void> => {
  await page.locator("textarea.pad").fill(text);
};

const exitToHome = async (page: Page): Promise<void> => {
  await page.locator('button.close').first().click();
  await waitForCel(page, "os.active", "home");
};

// ── scenario 1 — home screen ───────────────────────────────────────────────
const scHomeScreen = async (page: Page): Promise<void> => {
  console.log("\n▶ Scenario 1 — home screen lists Sheets, Notepad, Files, Doom");
  for (const t of ["Sheets", "Notepad", "Files", "Doom"]) {
    const visible = await page.locator(`button:has-text("${t}")`).first().isVisible();
    ok(visible, `${t} icon visible`);
  }
};

// ── scenario 1b — Desktop README is the first thing you see in Files ────────
const scDesktopReadme = async (page: Page): Promise<void> => {
  console.log("\n▶ Scenario 1b — Files opens to /Desktop with the README");
  await page.locator('button:has-text("Files")').first().click();
  ok(await waitForCel(page, "os.active", "file-explorer"), "Files launched");
  ok(await waitForCel(page, "file-explorer.cwd", "/Desktop"), "starts on /Desktop");

  // README card visible with the notepad icon (📝, from fe.app-types).
  await page.locator('div.card.file:has-text("README.txt")').first().waitFor({ state: "visible", timeout: 2000 });
  const readme = page.locator('div.card.file:has-text("README.txt")').first();
  ok(await readme.isVisible(), "README.txt visible on Desktop");
  ok((await readme.innerText()).includes("📝"), "README has the notepad icon");

  // Click → opens it in Notepad with the welcome content.
  await readme.click();
  ok(await waitForCel(page, "os.active", "notepad"), "Notepad opened to read README");
  ok(await waitForCel(page, "os.doc", "README.txt"), "os.doc=README.txt");
  const text = (await cel(page, "notepad.text") as string | undefined) ?? "";
  ok(text.includes("plastron-OS"), "README mentions plastron-OS");

  await exitToHome(page);
};

// ── scenario 2 — Notepad full lifecycle ─────────────────────────────────────
const scNotepadLifecycle = async (page: Page, suffix: string): Promise<{ docA: string; docB: string }> => {
  console.log("\n▶ Scenario 2 — Notepad lifecycle (New/Save/Open/Close)");
  const docA = `notes-A-${suffix}.txt`, docB = `notes-B-${suffix}.txt`;

  await page.locator('button:has-text("Notepad")').first().click();
  ok(await waitForCel(page, "os.active", "notepad"), "Notepad launched");
  ok(await page.locator("textarea.pad").isVisible(), "textarea visible");

  // Toolbar's New / Save / Open are present.
  for (const cls of ["ft-new", "ft-save", "ft-open"]) {
    ok(await page.locator(`button.${cls}`).isVisible(), `toolbar ${cls} visible`);
  }

  // New → docA (programmatic; the click+prompt path is covered by toolbar visibility).
  await callFn(page, "file.new", docA);
  ok(await waitForCel(page, "os.doc", docA), "New created docA");
  eq(await cel(page, "notepad.text"), "", "fresh doc empty");
  eq(await page.locator(".file-toolbar .doc-name").innerText(), docA, "toolbar shows docA");

  // Type → save
  await typeIntoPad(page, "first thoughts");
  ok(await waitForCel(page, "notepad.text", "first thoughts"), "typed into A");
  await callFn(page, "file.save");
  await page.waitForTimeout(100);

  // New B → blank → type → save
  await callFn(page, "file.new", docB);
  ok(await waitForCel(page, "os.doc", docB), "New created docB");
  ok(await waitForCel(page, "notepad.text", ""), "docB starts empty");
  await typeIntoPad(page, "second draft");
  ok(await waitForCel(page, "notepad.text", "second draft"), "typed into B");
  await callFn(page, "file.save");
  await page.waitForTimeout(100);

  // Open A → original text restored
  await callFn(page, "file.open", docA);
  ok(await waitForCel(page, "os.doc", docA), "Open A returned doc name");
  ok(await waitForCel(page, "notepad.text", "first thoughts"), "A restored");

  // Edit A → save
  await typeIntoPad(page, "first thoughts, revised");
  ok(await waitForCel(page, "notepad.text", "first thoughts, revised"), "A edited");
  await callFn(page, "file.save");
  await page.waitForTimeout(100);

  // Open B → still unchanged (no cross-doc leak)
  await callFn(page, "file.open", docB);
  ok(await waitForCel(page, "notepad.text", "second draft"), "B unchanged");

  // Open A again → revision persisted across the round-trip
  await callFn(page, "file.open", docA);
  ok(await waitForCel(page, "notepad.text", "first thoughts, revised"), "A revised persisted");

  // Close (Exit) → home; re-launch via icon
  await exitToHome(page);
  ok((await cel(page, "os.active")) === "home", "exited to home");
  await page.locator('button:has-text("Notepad")').first().click();
  ok(await waitForCel(page, "os.active", "notepad"), "re-launched notepad");

  // Back to home for the next scenario.
  await exitToHome(page);
  return { docA, docB };
};

// ── scenario 3 — File Explorer v2: cwd, folders, navigation ─────────────────
const scFileExplorerNavigate = async (page: Page, docA: string, docB: string): Promise<void> => {
  console.log("\n▶ Scenario 3 — File Explorer v2 — navigate into /notepad and open a file");
  await page.locator('button:has-text("Files")').first().click();
  ok(await waitForCel(page, "os.active", "file-explorer"), "File Explorer launched");

  // The default cwd is /Desktop now; nav to / so the rest of this scenario
  // sees the same starting view it always did.
  await callFn(page, "fe.cd", "/");
  await waitForCel(page, "file-explorer.cwd", "/");
  await callFn(page, "fe.refresh");
  await page.waitForTimeout(100);

  // At root: the auto-filed /notepad folder is visible; files aren't.
  ok(await page.locator('button.card.folder:has-text("notepad")').first().isVisible(), "/notepad folder visible at root");
  eq(await page.locator(`div.card.file:has-text("${docA}")`).count(), 0, "docA file NOT at root (it's in /notepad)");

  // Click into the notepad folder. The two notepad docs from scenario 2 land here.
  await page.locator('button.card.folder:has-text("notepad")').first().click();
  ok(await waitForCel(page, "file-explorer.cwd", "/notepad"), "cwd=/notepad");
  // Painter is rAF-batched; give it a tick.
  await page.waitForTimeout(150);
  for (const name of [docA, docB]) {
    ok(await page.locator(`div.card.file:has-text("${name}")`).first().isVisible(), `${name} visible in /notepad`);
  }
  ok(await page.locator('button.card.up').first().isVisible(), ".. (parent) card visible");

  // Click .. → back to root.
  await page.locator('button.card.up').first().click();
  ok(await waitForCel(page, "file-explorer.cwd", "/"), "back at root via ..");
  await page.waitForTimeout(100);

  // Navigate via breadcrumb back into /notepad, then click docA.
  await page.locator('button.card.folder:has-text("notepad")').first().click();
  await waitForCel(page, "file-explorer.cwd", "/notepad");
  await page.waitForTimeout(100);

  await page.locator(`div.card.file:has-text("${docA}")`).first().click();
  ok(await waitForCel(page, "os.active", "notepad"), "fe → notepad");
  ok(await waitForCel(page, "notepad.text", "first thoughts, revised"), "docA content");

  await exitToHome(page);
};

// ── scenario 4 — mkdir + drag-drop a file into it ───────────────────────────
const scFileExplorerMkdirAndDragDrop = async (page: Page, docA: string, suffix: string): Promise<void> => {
  console.log("\n▶ Scenario 4 — File Explorer + mkdir + drag-drop");
  const folder = `archive-${suffix}`;
  const folderPath = `/${folder}`;

  await page.locator('button:has-text("Files")').first().click();
  await waitForCel(page, "os.active", "file-explorer");
  // Reset cwd to root (a previous scenario may have left it elsewhere).
  await callFn(page, "fe.cd", "/");
  await waitForCel(page, "file-explorer.cwd", "/");

  // mkdir at root — the new folder appears immediately.
  await callFn(page, "fe.mkdir", folder);
  await page.waitForTimeout(150);
  ok(await page.locator(`button.card.folder:has-text("${folder}")`).first().isVisible(), `${folder} folder visible after mkdir`);

  // Drag docA (which lives in /notepad) directly into /<folder> via the
  // helper. We can't synthesize a real HTML5 dragstart→drop sequence over CDP
  // (Playwright's page.dragAndDrop uses mouse events; the kernel binds to
  // dragstart/drop). So we exercise the move() helper directly — the dnd
  // wrappers `fe.dragstart` / `fe.drop` are themselves tested in unit tests.
  await callFn(page, "fe.move", docA, folderPath);
  await page.waitForTimeout(100);

  // docA now lives in /<folder>: navigate into it and see the file card.
  await page.locator(`button.card.folder:has-text("${folder}")`).first().click();
  ok(await waitForCel(page, "file-explorer.cwd", folderPath), `cwd=${folderPath}`);
  // Wait for the file card to attach (painter is rAF-batched after cwd flip).
  await page.locator(`div.card.file:has-text("${docA}")`).first().waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
  ok(await page.locator(`div.card.file:has-text("${docA}")`).first().isVisible(), `${docA} visible in /${folder}`);

  // Reload the page (fresh OPFS state already; just exit + re-enter via UI
  // to prove the location survived the save).
  await exitToHome(page);
  await page.locator('button:has-text("Files")').first().click();
  await waitForCel(page, "os.active", "file-explorer");
  await callFn(page, "fe.cd", "/");                // reset cwd to root
  await waitForCel(page, "file-explorer.cwd", "/");
  await callFn(page, "fe.refresh");
  await page.waitForTimeout(100);
  await page.locator(`button.card.folder:has-text("${folder}")`).first().click();
  await waitForCel(page, "file-explorer.cwd", folderPath);
  await page.waitForTimeout(100);
  ok(await page.locator(`div.card.file:has-text("${docA}")`).first().isVisible(), `${docA} still in /${folder} after exit + re-enter`);

  await exitToHome(page);
};

// ── scenario 4b — drag-drop via the real dragstart/drop fns ─────────────────
// We can't easily synthesize a true HTML5 dragstart→drop sequence over CDP
// (Playwright's drag uses mouse events, the kernel listens for the HTML5
// 'dragstart'/'drop' events). So we cover the dispatch wiring by calling the
// registered fns directly with a real-shaped event object + DataTransfer,
// and assert the cel state moves as expected.
const scDragDropDispatch = async (page: Page, docB: string): Promise<void> => {
  console.log("\n▶ Scenario 4b — fe.dragstart + fe.drop wire through to fe.move");
  const folder = `drop-${Math.random().toString(36).slice(2, 6)}`;
  await page.locator('button:has-text("Files")').first().click();
  await waitForCel(page, "os.active", "file-explorer");
  await callFn(page, "fe.cd", "/");
  await waitForCel(page, "file-explorer.cwd", "/");
  await callFn(page, "fe.mkdir", folder);

  // Simulate the events: dragstart sets dataTransfer, drop reads it.
  await page.evaluate(async ({ name, target }) => {
    const pl = (window as { __plastron?: { resolveFn: (k: string) => (...x: unknown[]) => unknown; state: unknown } }).__plastron!;
    const evt: { dataTransfer: { _data: Record<string, string>; setData(k: string, v: string): void; getData(k: string): string; effectAllowed: string; dropEffect: string }; preventDefault(): void } = {
      preventDefault() {},
      dataTransfer: {
        _data: {},
        setData(k: string, v: string) { this._data[k] = v; },
        getData(k: string) { return this._data[k] ?? ""; },
        effectAllowed: "",
        dropEffect: "",
      },
    };
    await pl.resolveFn("fe.dragstart")(pl.state, name, evt);
    await pl.resolveFn("fe.drop")(pl.state, target, evt);
  }, { name: docB, target: `/${folder}` });

  // Wait until fs-tree.locations actually reflects the move (the dispatch
  // chain is awaited inside page.evaluate, but the cel propagation +
  // painter rAF still need a tick).
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const locs = (await cel(page, "fs-tree.locations")) as Record<string, string> | undefined;
    if (locs && locs[docB] === `/${folder}`) break;
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(100); // one more painter cycle

  await page.locator(`button.card.folder:has-text("${folder}")`).first().click();
  ok(await waitForCel(page, "file-explorer.cwd", `/${folder}`), `cwd=/${folder}`);
  ok(await page.locator(`div.card.file:has-text("${docB}")`).first().isVisible(), `${docB} landed in /${folder} via dragstart+drop`);

  await exitToHome(page);
};

// ── scenario 4c — file picker modal (Notepad Open shows the picker) ─────────
// Earlier scenarios moved docA + docB out of /notepad, so this scenario
// creates a fresh doc to exercise the picker on.
const scOpenPicker = async (page: Page, suffix: string): Promise<void> => {
  console.log("\n▶ Scenario 4c — Notepad's Open shows a picker modal");
  const docC = `notes-picker-${suffix}.txt`;

  await page.locator('button:has-text("Notepad")').first().click();
  ok(await waitForCel(page, "os.active", "notepad"), "Notepad launched");
  // A fresh doc in /notepad — that's where the picker will land.
  await callFn(page, "file.new", docC);
  await page.locator("textarea.pad").fill("picker-target");
  await waitForCel(page, "notepad.text", "picker-target");
  await callFn(page, "file.save");

  // Open a different doc first so we can prove the picker switches docs.
  await callFn(page, "file.new", `${docC}-other`);
  await page.locator("textarea.pad").fill("other doc");
  await callFn(page, "file.save");

  // Click Open → modal opens (data-open=true) and shows file cards.
  await page.locator('button.ft-open').first().click();
  ok(await waitForCel(page, "picker.app", "notepad"), "picker opens for notepad");
  ok(await page.locator('.picker-root[data-open="true"]').first().isVisible(), "picker modal visible");

  // docC is in /notepad — the picker should land there and show it.
  await page.locator(`button.card.file:has-text("${docC}")`).first().waitFor({ state: "visible", timeout: 2000 });
  ok(await page.locator(`button.card.file:has-text("${docC}")`).first().isVisible(), `${docC} in picker`);

  // Click the file → picker closes + that doc is the active one.
  await page.locator(`button.card.file:has-text("${docC}")`).first().click();
  ok(await waitForCel(page, "picker.app", null), "picker closed after select");
  ok(await waitForCel(page, "os.doc", docC), `os.doc=${docC} after picker select`);
  ok(await waitForCel(page, "notepad.text", "picker-target"), `${docC} content loaded`);

  // Re-open the picker and use the × close button.
  await page.locator('button.ft-open').first().click();
  ok(await waitForCel(page, "picker.app", "notepad"), "picker re-opens");
  await page.locator('.picker-x').first().click();
  ok(await waitForCel(page, "picker.app", null), "× closed the picker");

  // Once more, and click the backdrop's corner (the centered panel covers
  // the default click position) to cancel.
  await page.locator('button.ft-open').first().click();
  await waitForCel(page, "picker.app", "notepad");
  await page.locator('.picker-backdrop').first().click({ position: { x: 10, y: 10 } });
  ok(await waitForCel(page, "picker.app", null), "backdrop click closed the picker");

  await exitToHome(page);
};

// ── scenario 5 — Sheets round-trip ──────────────────────────────────────────
const scSheetsRoundTrip = async (page: Page, suffix: string): Promise<void> => {
  console.log("\n▶ Scenario 5 — Sheets — open, edit, save, new, open A round-trip");
  await page.locator('button:has-text("Sheets")').first().click();
  ok(await waitForCel(page, "os.active", "sheets"), "Sheets launched");
  // The grid is rAF-painted — let it land before querying.
  await page.locator('td[data-addr="A1"]').first().waitFor({ state: "attached", timeout: 2000 }).catch(() => {});
  ok((await page.locator('td[data-addr="A1"]').count()) > 0, "grid attached (A1 cell present)");

  const docA = `book-A-${suffix}.csv`, docB = `book-B-${suffix}.csv`;

  // New A → A1 = "Apples" via the formula bar.
  await callFn(page, "file.new", docA);
  ok(await waitForCel(page, "os.doc", docA), "New A");
  await page.locator('td.cell[data-addr="A1"]').click();
  await page.locator('input.fx').fill("Apples");
  await page.locator('button:has-text("✓")').click();
  ok(await waitForCel(page, "sheet.A1", "Apples"), "A1=Apples");

  // B1 = 10
  await page.locator('td.cell[data-addr="B1"]').click();
  await page.locator('input.fx').fill("10");
  await page.locator('button:has-text("✓")').click();
  ok(await waitForCel(page, "sheet.B1", 10), "B1=10");

  await callFn(page, "file.save");
  await page.waitForTimeout(100);

  // New B → blank grid
  await callFn(page, "file.new", docB);
  ok(await waitForCel(page, "os.doc", docB), "New B");
  ok(await waitForCel(page, "sheet.A1", ""), "B's A1 blank");

  await page.locator('td.cell[data-addr="A1"]').click();
  await page.locator('input.fx').fill("Bananas");
  await page.locator('button:has-text("✓")').click();
  await callFn(page, "file.save");
  await page.waitForTimeout(100);

  // Open A → cells restored
  await callFn(page, "file.open", docA);
  ok(await waitForCel(page, "sheet.A1", "Apples"), "A1 restored");
  ok(await waitForCel(page, "sheet.B1", 10), "B1 restored");

  await exitToHome(page);
};

// ── entry point ─────────────────────────────────────────────────────────────
export const runScenarios = async (baseURL: string): Promise<number> => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const browser = await launch();
  try {
    const { ctx, page } = await newPage(browser, baseURL);
    await scHomeScreen(page);
    await scDesktopReadme(page);
    const { docA, docB } = await scNotepadLifecycle(page, suffix);
    await scFileExplorerNavigate(page, docA, docB);
    await scFileExplorerMkdirAndDragDrop(page, docA, suffix);
    await scDragDropDispatch(page, docB);
    await scOpenPicker(page, suffix);
    await scSheetsRoundTrip(page, suffix);
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\n${fails === 0 ? "🟢" : "🔴"} ${passes} passing, ${fails} failing`);
  return fails === 0 ? 0 : 1;
};
