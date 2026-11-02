// Split bytes before decoding. An oversized or malformed line is discarded in
// bounded memory and does not prevent processing the next line.
export async function* boundedLines(
  input: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): AsyncGenerator<string | null> {
  let parts: Buffer[] = [];
  let size = 0;
  let oversized = false;
  const decode = () => {
    if (oversized) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.concat(parts, size))
        .replace(/\r$/, "");
    } catch {
      return null;
    }
  };
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start);
      const stop = end < 0 ? bytes.length : end;
      const part = bytes.subarray(start, stop);
      size += part.length;
      if (size > maxBytes) {
        oversized = true;
        parts = [];
      } else if (!oversized) parts.push(part);
      if (end >= 0) {
        yield decode();
        parts = [];
        size = 0;
        oversized = false;
      }
      start = stop + 1;
    }
  }
  if (size || oversized) yield decode();
}
