import type { SandboxResourceLimits } from "./types.js";

export interface CaptureSnapshot {
  readonly text: string;
  readonly capturedBytes: number;
  readonly truncated: boolean;
}

export class BoundedUtf8Capture {
  readonly #maxBytes: number;
  readonly #chunks: Buffer[] = [];
  #capturedBytes = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("capture maxBytes must be a positive safe integer");
    }
    this.#maxBytes = maxBytes;
  }

  append(value: string | Uint8Array): void {
    const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    const remaining = this.#maxBytes - this.#capturedBytes;
    if (remaining <= 0) {
      if (chunk.length > 0) {
        this.#truncated = true;
      }
      return;
    }
    if (chunk.length <= remaining) {
      this.#chunks.push(chunk);
      this.#capturedBytes += chunk.length;
      return;
    }
    this.#chunks.push(chunk.subarray(0, remaining));
    this.#capturedBytes += remaining;
    this.#truncated = true;
  }

  snapshot(): CaptureSnapshot {
    return Object.freeze({
      text: Buffer.concat(this.#chunks, this.#capturedBytes).toString("utf8"),
      capturedBytes: this.#capturedBytes,
      truncated: this.#truncated,
    });
  }
}

export class SandboxResourcePolicy {
  readonly limits: SandboxResourceLimits;

  constructor(limits: SandboxResourceLimits) {
    this.limits = limits;
  }

  createExecutionTimeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.limits.executionTimeoutMs);
  }

  createOutputCapture(): BoundedUtf8Capture {
    return new BoundedUtf8Capture(this.limits.outputCaptureBytes);
  }

  createDiagnosticCapture(): BoundedUtf8Capture {
    return new BoundedUtf8Capture(this.limits.diagnosticCaptureBytes);
  }
}
