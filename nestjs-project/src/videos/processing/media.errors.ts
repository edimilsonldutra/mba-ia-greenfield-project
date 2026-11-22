/** The file itself cannot be processed: retrying is useless. */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Something around the file failed (network, timeout, missing binary). */
export class MediaToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}
