// Crash-safe file write, shared by the tool layer and the memory store.
//
// Write `content` to a tmp file in the same directory, then rename over the
// destination. A crash, Ctrl-C or SIGKILL mid-write leaves the destination
// untouched (previous content intact) instead of truncated or empty. The tmp
// name is uniquified (pid + timestamp + random) so two concurrent writes to
// the same file don't collide on the tmp path.
//
// Same pattern as saveSettings in core/config.mjs. Lives in its own module so
// core/ can use it without importing tools/index.mjs (which imports core/).

import fs from "node:fs";
import path from "node:path";

// On Windows a rename over an existing file fails with EPERM/EBUSY/EACCES
// whenever anything holds a handle on either path for an instant — an
// antivirus scanner opening the file we just wrote is the common one, and it
// showed up as a spurious EPERM in a full test run. The window is
// milliseconds, so retry briefly before giving up; a genuine permission
// problem still surfaces after the last attempt.
const RENAME_RETRIES = 5;
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

function renameWithRetry(tmp, file) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt >= RENAME_RETRIES || !TRANSIENT.has(e.code)) throw e;
      // Busy-wait: this helper is synchronous by contract (callers are
      // sync tool implementations), so there is no yielding to do.
      const until = Date.now() + 10 * (attempt + 1);
      while (Date.now() < until) { /* brief backoff */ }
    }
  }
}

export function atomicWriteFileSync(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, content);
    renameWithRetry(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}
