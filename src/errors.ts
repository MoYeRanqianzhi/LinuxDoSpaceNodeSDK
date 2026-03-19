/**
 * LinuxDoSpaceError is the shared base error for all SDK failures.
 * Consumers can catch this class to handle all SDK-originated errors in one branch.
 */
export class LinuxDoSpaceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LinuxDoSpaceError";
  }
}

/**
 * AuthenticationError is raised when the backend rejects the provided API token.
 */
export class AuthenticationError extends LinuxDoSpaceError {
  public constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

/**
 * StreamError is raised when the upstream NDJSON mail stream cannot be opened
 * or decoded safely.
 */
export class StreamError extends LinuxDoSpaceError {
  public constructor(message: string) {
    super(message);
    this.name = "StreamError";
  }
}
