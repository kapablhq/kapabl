#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { run } from "../src/index.ts";

// Opened on the first question only, so commands that never ask leave stdin alone and
// Ctrl-C stops them the usual way.
let rl: Interface | undefined;
const ask = stdin.isTTY
  ? (question: string) => {
      if (!rl) {
        rl = createInterface({ input: stdin, output: stdout });
        // A readline interface swallows Ctrl-C; stop as the shell expects, saving nothing.
        rl.on("SIGINT", () => {
          rl?.close();
          process.exit(130);
        });
      }
      return rl.question(question);
    }
  : undefined;
const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
  now: () => new Date(),
  ask,
});
rl?.close();
process.exitCode = code;
