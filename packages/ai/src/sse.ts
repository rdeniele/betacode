/** Minimal Server-Sent-Events reader for `text/event-stream` bodies. Yields the `data:` payload of each event. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // Events are separated by a blank line (LF or CRLF).
      while ((idx = nextBoundary(buffer)) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^(\r?\n){1,2}/, "");
        const data = parseEvent(raw);
        if (data !== null) yield data;
      }
    }
    buffer += decoder.decode();
    const tail = parseEvent(buffer);
    if (tail !== null) yield tail;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function nextBoundary(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseEvent(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? data.join("\n") : null;
}
