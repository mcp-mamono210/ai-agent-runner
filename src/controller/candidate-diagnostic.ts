import type {
  CandidateDiagnosticKind,
  CandidateDiagnosticReason,
  CandidateDiagnosticSink,
} from "./types.js";

export class NoopCandidateDiagnosticSink implements CandidateDiagnosticSink {
  record(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Operator-visible default used by the production composition root.
 * Only the bounded Candidate Diagnostic Boundary payload is serialized.
 */
export class StderrCandidateDiagnosticSink implements CandidateDiagnosticSink {
  record(input: {
    readonly kind: CandidateDiagnosticKind;
    readonly issueId?: number;
    readonly reason: CandidateDiagnosticReason;
  }): Promise<void> {
    const payload = {
      kind: input.kind,
      ...(input.issueId === undefined ? {} : { issue_id: input.issueId }),
      reason: input.reason,
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    return Promise.resolve();
  }
}

export async function recordCandidateDiagnostic(
  sink: CandidateDiagnosticSink,
  input: {
    readonly kind: CandidateDiagnosticKind;
    readonly issueId?: number;
    readonly reason: CandidateDiagnosticReason;
  },
): Promise<void> {
  try {
    await sink.record(input);
  } catch {
    throw new Error("candidate diagnostic sink failed; raw diagnostic content suppressed");
  }
}
