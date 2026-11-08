// SPDX-License-Identifier: Apache-2.0
// Fails when a source file lacks an SPDX-License-Identifier header, or when the
// header disagrees with the `license` field of the nearest package.json (AGENTS.md L1).
// Files under a vendor/ directory only need a header.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SOURCE = /\.(?:[cm]?[jt]sx?|py|sh|html|css)$/;
const SKIP = [/(^|\/)worker-configuration\.d\.ts$/];
const HEADER_LINES = 5;
// Third-party files copied verbatim keep their own license; they still need a header.
const VENDORED = /(^|\/)vendor\//;

// -z: without it git quotes names with non-ASCII or special characters, and they would be
// skipped silently.
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((f) => SOURCE.test(f) && !SKIP.some((re) => re.test(f)) && existsSync(f));

const licenseCache = new Map();
function packageLicense(file) {
  let dir = dirname(file);
  for (;;) {
    if (licenseCache.has(dir)) return licenseCache.get(dir);
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const license = JSON.parse(readFileSync(pkg, "utf8")).license ?? null;
      licenseCache.set(dir, license);
      return license;
    }
    if (dir === "." || dir === "/") return null;
    dir = dirname(dir);
  }
}

const problems = [];
for (const file of files) {
  const head = readFileSync(file, "utf8").split("\n", HEADER_LINES).join("\n");
  const match = head.match(/SPDX-License-Identifier:\s*([^\s*]+)/);
  if (!match) {
    problems.push(`${file}: missing SPDX-License-Identifier header`);
    continue;
  }
  const expected = packageLicense(file);
  if (expected && match[1] !== expected && !VENDORED.test(file)) {
    problems.push(`${file}: header says ${match[1]}, package.json says ${expected}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} file(s) failed the SPDX check.`);
  process.exit(1);
}
console.log(`SPDX check passed (${files.length} files).`);
