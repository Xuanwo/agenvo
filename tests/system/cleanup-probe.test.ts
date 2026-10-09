// Temporary Windows lifecycle experiment; removed after CI validation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { eventsLab } from "../support/events-lab.js";

test(
  "suite owner reclaims a directory held by a live test process",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const lab = await eventsLab(t);
    // Windows keeps the current directory open until this isolated test process
    // exits. Early deletion must fail; the outer suite must still exit cleanly.
    const held = join(lab.root, "held");
    await mkdir(held);
    process.chdir(held);
    await assert.rejects(rm(held, { recursive: true, force: true }), {
      code: "EBUSY",
    });
  },
);
