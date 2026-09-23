export class RequestBodyError extends Error {
  constructor(
    public readonly code: "BODY_TOO_LARGE" | "INVALID_CONTENT_LENGTH" | "INVALID_UTF8",
    message: string
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

export async function readRequestBodyLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new RequestBodyError("INVALID_CONTENT_LENGTH", "Invalid Content-Length");
    }
    if (parsed > maxBytes) {
      throw new RequestBodyError("BODY_TOO_LARGE", "Request body exceeds configured maximum");
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError("BODY_TOO_LARGE", "Request body exceeds configured maximum");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyError("INVALID_UTF8", "Request body is not valid UTF-8");
  }
}
