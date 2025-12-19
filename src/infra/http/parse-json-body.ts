import { InvalidJsonBodyError, PayloadTooLargeError } from './errors';

function parseContentLength(contentLengthHeader: string | null): number | null {
  if (!contentLengthHeader) return null;
  const parsed = Number.parseInt(contentLengthHeader, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readRequestBodyTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new PayloadTooLargeError(0);
  }

  const contentLength = parseContentLength(request.headers.get('content-length'));
  if (contentLength !== null && contentLength > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }

  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let isDone = false;

  while (!isDone) {
    const { done, value } = await reader.read();
    isDone = done;
    if (done) continue;
    if (!value) continue;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

export async function parseJsonBodyWithLimit(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readRequestBodyTextWithLimit(request, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonBodyError();
  }
}
