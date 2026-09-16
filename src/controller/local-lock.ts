export interface LocalIssueLock {
  tryAcquire(issueId: number): boolean;
  release(issueId: number): void;
  isHeld(issueId: number): boolean;
}

/**
 * v0.4.0 starts with one Controller process, one Worker, and concurrency=1.
 * A process-local lock is therefore sufficient duplicate prevention without
 * creating another durable execution-state authority.
 *
 * The lock intentionally disappears with the process. Startup recovery is
 * based on Redmine durable execution state, not on this transient set.
 */
export class InMemoryIssueLock implements LocalIssueLock {
  readonly #heldIssueIds = new Set<number>();

  tryAcquire(issueId: number): boolean {
    assertPositiveIssueId(issueId);
    if (this.#heldIssueIds.has(issueId)) {
      return false;
    }
    this.#heldIssueIds.add(issueId);
    return true;
  }

  release(issueId: number): void {
    assertPositiveIssueId(issueId);
    this.#heldIssueIds.delete(issueId);
  }

  isHeld(issueId: number): boolean {
    assertPositiveIssueId(issueId);
    return this.#heldIssueIds.has(issueId);
  }
}

function assertPositiveIssueId(issueId: number): void {
  if (!Number.isSafeInteger(issueId) || issueId <= 0) {
    throw new Error("issueId must be a positive safe integer");
  }
}
