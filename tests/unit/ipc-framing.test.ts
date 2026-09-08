import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from "../../src/ipc/framing.js";
describe("IPC framing", () => {
  it("round-trips fragmented frames", () => {
    const frame = encodeFrame({ hello: "world" });
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([{ hello: "world" }]);
  });
  it("rejects oversized frames", () => {
    expect(() => encodeFrame({ data: "x".repeat(MAX_FRAME_BYTES) })).toThrow(/large/i);
  });
  it("rejects oversized incoming headers and malformed JSON", () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect(() => new FrameDecoder().push(oversized)).toThrow(/maximum size/i);
    const malformed = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("{")]);
    expect(() => new FrameDecoder().push(malformed)).toThrow(/valid JSON/i);
  });
});
