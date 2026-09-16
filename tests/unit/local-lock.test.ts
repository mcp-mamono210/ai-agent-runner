import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryIssueLock } from "../../src/controller/local-lock.js";

void describe("InMemoryIssueLock", () => {
  void it("allows one active local execution for the same issue", () => {
    const lock = new InMemoryIssueLock();

    assert.equal(lock.tryAcquire(5410), true);
    assert.equal(lock.tryAcquire(5410), false);
    assert.equal(lock.isHeld(5410), true);

    lock.release(5410);

    assert.equal(lock.isHeld(5410), false);
    assert.equal(lock.tryAcquire(5410), true);
  });

  void it("does not treat different issue IDs as the same lock", () => {
    const lock = new InMemoryIssueLock();

    assert.equal(lock.tryAcquire(5410), true);
    assert.equal(lock.tryAcquire(5411), true);
  });
});
