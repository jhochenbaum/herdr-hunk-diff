#!/usr/bin/env node
import { runTerminalSendReviewPicker } from "../picker.js";
import { buildRuntime } from "../runtime.js";
import { isMainModule } from "./main-guard.js";

if (isMainModule(import.meta.url)) {
  process.exit(await runTerminalSendReviewPicker(buildRuntime(process.env)));
}
