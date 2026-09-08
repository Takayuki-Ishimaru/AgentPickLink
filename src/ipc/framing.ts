import { DomainError } from "../domain/errors.js";
export const MAX_FRAME_BYTES = 1_048_576;
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES)
    throw new DomainError("BROKER_PROTOCOL_ERROR", "IPC frame is too large.");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const values: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES)
        throw new DomainError("BROKER_PROTOCOL_ERROR", "IPC frame exceeds the maximum size.");
      if (this.buffer.length < length + 4) break;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      try {
        values.push(JSON.parse(body.toString("utf8")));
      } catch {
        throw new DomainError("BROKER_PROTOCOL_ERROR", "IPC frame is not valid JSON.");
      }
    }
    return values;
  }
}
