export class ShillError extends Error {
  constructor(message, { exitCode = 1, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ShillError';
    this.exitCode = exitCode;
  }
}
