// A queue read as an async iterable: the frames a job takes in turn, or the messages an adapter feeds its harness.
export class Inbox<T> implements AsyncIterable<T> {
  readonly #queued: T[] = []
  #waiting: ((result: IteratorResult<T>) => void) | undefined
  #closed = false

  push(item: T): void {
    if (this.#closed) return
    const waiting = this.#waiting
    if (waiting === undefined) return void this.#queued.push(item)
    this.#waiting = undefined
    waiting({ done: false, value: item })
  }

  close(): void {
    this.#closed = true
    const waiting = this.#waiting
    this.#waiting = undefined
    waiting?.({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#queued.shift()
        if (item !== undefined) return Promise.resolve({ done: false, value: item })
        if (this.#closed) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => (this.#waiting = resolve))
      },
    }
  }
}
