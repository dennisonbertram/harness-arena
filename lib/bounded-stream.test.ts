import { describe, expect, it, vi } from "vitest";
import { readBoundedStream } from "./bounded-stream";

describe("readBoundedStream", () => {
  it("enforces the observed chunk total and cancels even without a trustworthy content-length", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); },
      cancel,
    });
    await expect(readBoundedStream(stream, 10)).rejects.toThrow("payload too large");
    expect(cancel).toHaveBeenCalled();
  });

  it("returns the exact bytes when chunked content stays within the ceiling", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close(); } });
    await expect(readBoundedStream(stream, 3)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });
});
