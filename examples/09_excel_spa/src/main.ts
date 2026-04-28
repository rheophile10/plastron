import { bootSheet } from "./sheet.js";
import { mountUI } from "./ui.js";

const rt = await bootSheet();
mountUI(rt);
