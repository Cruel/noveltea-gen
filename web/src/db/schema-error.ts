/** Backend-neutral database initialization and schema verification error. */
export class StudioSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioSchemaError'
  }
}
