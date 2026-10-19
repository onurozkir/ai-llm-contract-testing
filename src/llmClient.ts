/**
 * Transport client with hard deadline enforcement via AbortController.
 * Raw provider output crosses this layer before reaching the contract layer.
 */

export type TransportResult =
  | { ok: true; text: string; elapsedMs: number }
  | {
      ok: false;
      reason: "timeout" | "http_5xx" | "http_4xx" | "network";
      status?: number;
      elapsedMs: number;
    };

/**
 * Sends a POST request with JSON payload to the LLM provider URL.
 * Aborts strictly if deadlineMs expires.
 */
export async function postSuggestionRequest(
  url: string,
  body: string,
  deadlineMs: number
): Promise<TransportResult> {
  const start = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, deadlineMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });

    const text = await response.text();
    const elapsedMs = Math.round(performance.now() - start);

    if (response.status >= 500) {
      return {
        ok: false,
        reason: "http_5xx",
        status: response.status,
        elapsedMs,
      };
    }

    if (response.status >= 400) {
      return {
        ok: false,
        reason: "http_4xx",
        status: response.status,
        elapsedMs,
      };
    }

    return {
      ok: true,
      text,
      elapsedMs,
    };
  } catch (err: unknown) {
    const elapsedMs = Math.round(performance.now() - start);
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError"));

    if (isAbort) {
      return {
        ok: false,
        reason: "timeout",
        elapsedMs,
      };
    }

    return {
      ok: false,
      reason: "network",
      elapsedMs,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

