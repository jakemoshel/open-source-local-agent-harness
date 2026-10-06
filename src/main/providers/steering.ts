/** The run stopped accepting input before this message reached the provider; it is safe to start a new turn. */
export class SteeringClosedError extends Error {}

/** Serial delivery, including messages submitted while the provider is starting. */
export class SteeringChannel {
  private handler: ((text: string) => Promise<void>) | null = null
  private closed = false
  private pending: { text: string; resolve: () => void; reject: (err: Error) => void }[] = []
  private draining: Promise<void> | null = null

  send(text: string): Promise<void> {
    if (this.closed) return Promise.reject(new SteeringClosedError('This run has finished accepting messages. Send again to start a new turn.'))
    const result = new Promise<void>((resolve, reject) => this.pending.push({ text, resolve, reject }))
    this.pump()
    return result
  }

  register(handler: (text: string) => Promise<void>): void {
    if (this.closed) return
    this.handler = handler
    this.pump()
  }

  private pump(): void {
    if (this.draining || !this.handler || this.closed) return
    this.draining = (async () => {
      while (!this.closed && this.pending.length) {
        const item = this.pending.shift()!
        try {
          await this.handler!(item.text)
          item.resolve()
        } catch (err) {
          item.reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })().finally(() => {
      this.draining = null
      if (this.pending.length) this.pump()
    })
  }

  get isClosed(): boolean { return this.closed }

  close(): Promise<void> {
    this.closed = true
    for (const item of this.pending.splice(0)) item.reject(new SteeringClosedError('Run ended before this message could be delivered. Send it again.'))
    return this.draining ?? Promise.resolve()
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private wake: (() => void) | null = null
  private ended = false
  private error: Error | null = null

  push(value: T): void {
    if (this.ended) throw new Error('Stream is closed')
    this.values.push(value)
    this.wake?.()
  }

  end(error?: Error): void {
    this.ended = true
    this.error = error ?? null
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.values.length) yield this.values.shift()!
      else if (this.ended) {
        if (this.error) throw this.error
        return
      } else await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}
