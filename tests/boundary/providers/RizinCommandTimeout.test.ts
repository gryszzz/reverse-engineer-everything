import { describe, expect, it } from "vitest";

import {
  createRizinCommandTimeoutError,
  isRizinCommandDeadlineExpired,
  RizinCommandTimeoutError,
} from "../../../src/rizin/RizinDebugSessionManager.js";

describe("Rizin command timeout semantics", () => {
  it("treats zero and negative remaining time as expired", () => {
    expect(isRizinCommandDeadlineExpired(1)).toBe(false);
    expect(isRizinCommandDeadlineExpired(0)).toBe(true);
    expect(isRizinCommandDeadlineExpired(-1)).toBe(true);
  });

  it("retains partial frames separated by newlines in the timeout error", () => {
    const error = createRizinCommandTimeoutError([
      "first frame",
      "second frame",
    ]);

    expect(error).toBeInstanceOf(RizinCommandTimeoutError);
    expect(error.partialOutput).toBe("first frame\nsecond frame");
    expect(error.message).toBe(
      "Timed out waiting for Rizin's command-completion marker",
    );
  });
});
