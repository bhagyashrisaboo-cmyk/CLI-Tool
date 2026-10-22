/** Expected, user-facing failure. The CLI prints the message (no stack trace). */
export class ActionTrackError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'ActionTrackError';
    this.exitCode = exitCode;
  }
}

/** Gmail could not be used (missing library, credentials, auth or API error). */
export class GmailUnavailableError extends ActionTrackError {
  constructor(message, hint = null) {
    super(message, 3);
    this.name = 'GmailUnavailableError';
    this.hint = hint;
  }
}
