import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_POLL_INTERVAL_MS,
  parseAllowedProjectIds,
  parsePollIntervalMs,
} from "../../src/controller/config.js";

void describe("controller config", () => {
  void it("uses the canonical 30-second default polling interval", () => {
    assert.equal(parsePollIntervalMs(undefined), DEFAULT_POLL_INTERVAL_MS);
    assert.equal(DEFAULT_POLL_INTERVAL_MS, 30_000);
  });

  void it("parses a bounded explicit allowlist of Redmine project IDs", () => {
    assert.deepEqual(parseAllowedProjectIds("414, 415"), [414, 415]);
  });

  void it("rejects an absent or duplicate project allowlist", () => {
    assert.throws(() => parseAllowedProjectIds(undefined));
    assert.throws(() => parseAllowedProjectIds("414,414"));
  });
});
