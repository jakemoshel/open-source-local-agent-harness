// Run completion and outbound delivery are different moments. An update waits for both.
let pending = 0
export function holdCompletion(): () => void {
  pending++
  let released = false
  return () => { if (!released) { released = true; pending-- } }
}
export const pendingCompletions = () => pending
