import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectKnownSecretValues,
  KnownSecretRedactor,
} from "../../src/security/redaction.js";

void describe("Phase 48-5 reusable redaction", () => {
  void it("redacts configured known secret material and common credential syntax", () => {
    const redactor = new KnownSecretRedactor(["fixture-secret", "read-key"]);
    const result = redactor.redact(
      "token=fixture-secret\nAuthorization: Bearer abc\nX-Redmine-API-Key: read-key",
      "agent_diagnostic",
    );

    assert.doesNotMatch(result, /fixture-secret|read-key|Bearer abc/u);
    assert.match(result, /\[REDACTED\]/u);
  });

  void it("collects only present configured environment secrets", () => {
    const values = collectKnownSecretValues({
      environment: { A: "one", B: "", C: "three" },
      requiredValues: ["fixed", "one"],
      secretEnvironmentNames: ["A", "B", "C"],
    });

    assert.deepEqual(values, ["fixed", "one", "three"]);
  });
});
