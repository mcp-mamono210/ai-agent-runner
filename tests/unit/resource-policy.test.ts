import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BoundedUtf8Capture, SandboxResourcePolicy } from "../../src/sandbox/resource-policy.js";

const limits = {
  executionTimeoutMs: 1000,
  outputCaptureBytes: 5,
  diagnosticCaptureBytes: 4,
  workspaceDiskBytes: 1024,
  containerLifecycleMs: 2000,
  workspaceCheckIntervalMs: 100,
  tmpfsBytes: 128,
};

void describe("Phase 48-4 resource policy", () => {
  void it("bounds output and records truncation instead of retaining unbounded data", () => {
    const capture = new BoundedUtf8Capture(5);
    capture.append("abc");
    capture.append("defgh");

    assert.deepEqual(capture.snapshot(), {
      text: "abcde",
      capturedBytes: 5,
      truncated: true,
    });
  });

  void it("exposes separate finite execution/output/diagnostic controls", () => {
    const policy = new SandboxResourcePolicy(limits);
    assert.equal(policy.limits.executionTimeoutMs, 1000);
    assert.equal(policy.createOutputCapture().snapshot().capturedBytes, 0);
    assert.equal(policy.createDiagnosticCapture().snapshot().capturedBytes, 0);
    assert.equal(policy.createExecutionTimeoutSignal().aborted, false);
  });
});
