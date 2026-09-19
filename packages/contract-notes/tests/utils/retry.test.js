const { withRetry } = require("../../utils/retry");

describe("withRetry()", () => {
  test("returns immediately on first-attempt success", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, { attempts: 3 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on failure and eventually succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValue("success");
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).resolves.toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("rejects with last error after all attempts exhausted", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("always fails"));
    await expect(withRetry(fn, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("does not retry when retryIf returns false", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("auth error"));
    await expect(
      withRetry(fn, { attempts: 3, retryIf: () => false, baseDelayMs: 1 })
    ).rejects.toThrow("auth error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("calls onRetry with error, attempt number, and delay", async () => {
    const onRetry = jest.fn();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    await withRetry(fn, { attempts: 3, baseDelayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    const [err, attempt, delay] = onRetry.mock.calls[0];
    expect(err.message).toBe("transient");
    expect(attempt).toBe(1);
    expect(typeof delay).toBe("number");
  });

  test("respects attempts=1 (no retries)", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("fail"));
    await expect(withRetry(fn, { attempts: 1 })).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
