/**
 * A caller's mistake (unknown id, invalid argument, oversized record), not a defect in Jarvis.
 * invoke() returns it to the caller without recording a harness fault, so routine refusals never trigger self-repair.
 */
export class UsageError extends Error {
  override name = 'UsageError'
}
