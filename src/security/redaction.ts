const REDACTED_VALUE = "[REDACTED]";

export type RedactionContext =
  | "agent_output"
  | "agent_diagnostic"
  | "runtime_diagnostic"
  | "reconciliation_diagnostic"
  | "artifact_metadata";

export interface Redactor {
  redact(content: string, context: RedactionContext): string;
}

export class KnownSecretRedactor implements Redactor {
  readonly #secrets: readonly string[];

  constructor(secretValues: readonly string[]) {
    const normalized = [...new Set(secretValues)].filter((value) => value !== "");
    this.#secrets = Object.freeze(normalized);
  }

  redact(content: string, _context: RedactionContext): string {
    let output = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
    for (const secret of this.#secrets) {
      output = output.split(secret).join(REDACTED_VALUE);
    }

    output = output
      .replace(/(Authorization\s*:\s*)[^\n]+/giu, `$1${REDACTED_VALUE}`)
      .replace(/(X-Redmine-API-Key\s*:\s*)[^\n]+/giu, `$1${REDACTED_VALUE}`)
      .replace(
        /((?:password|credential|api[ _-]?key|token|secret)\s*[:=]\s*)[^\s,;\n]+/giu,
        `$1${REDACTED_VALUE}`,
      );

    for (const secret of this.#secrets) {
      if (output.includes(secret)) {
        throw new Error("redaction invariant failed");
      }
    }
    return output;
  }
}

export function collectKnownSecretValues(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly requiredValues?: readonly string[];
  readonly secretEnvironmentNames?: readonly string[];
}): readonly string[] {
  const values = [...(input.requiredValues ?? [])];
  for (const name of input.secretEnvironmentNames ?? []) {
    const value = input.environment[name];
    if (value !== undefined && value !== "") {
      values.push(value);
    }
  }
  return Object.freeze([...new Set(values)].filter((value) => value !== ""));
}
