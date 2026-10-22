export class OutsideInError extends Error {
  constructor(message, code = "USAGE") {
    super(message);
    this.name = "OutsideInError";
    this.code = code;
  }
}
