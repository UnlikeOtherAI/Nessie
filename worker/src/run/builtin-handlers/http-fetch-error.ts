export class HttpFetchError extends Error {
  override readonly name = 'HttpFetchError'

  constructor(message: string) {
    super(message)
  }
}
