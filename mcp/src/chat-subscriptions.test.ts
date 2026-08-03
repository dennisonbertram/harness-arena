import { describe, expect, it, vi } from "vitest";
import { ChatSubscriptions, canonicalChatResourceUri } from "./chat-subscriptions.js";

const eventually = async (assertion: () => void) => {
  await vi.waitFor(assertion, { timeout: 1_000, interval: 1 });
};

describe("competition chat resource subscriptions", () => {
  it("accepts only the canonical encoded chat resource URI", () => {
    expect(canonicalChatResourceUri("harness-arena://competitions/summer%202029/chat")).toEqual({
      uri: "harness-arena://competitions/summer%202029/chat",
      competitionId: "summer 2029",
    });
    for (const uri of [
      "harness-arena://competitions/summer 2029/chat",
      "harness-arena://competitions/summer%202029/chat?cursor=secret",
      "harness-arena://competitions/summer%202029/chat/",
      "harness-arena://other/summer%202029/chat",
      "https://competitions/summer%202029/chat",
    ]) expect(canonicalChatResourceUri(uri)).toBeUndefined();
  });

  it("runs one cursor-aware worker per URI, notifies only updates, and stops cleanly", async () => {
    let resolveSecondRead!: (value: unknown) => void;
    const client = {
      readCompetitionChat: vi.fn()
        .mockResolvedValueOnce({ page: { messages: [{ id: "safe-to-count-only" }], next_cursor: "cursor-1" } })
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondRead = resolve; })),
    };
    const notify = vi.fn().mockResolvedValue(undefined);
    const subscriptions = new ChatSubscriptions({ client, notify, retryBaseMs: 1, retryMaxMs: 2, random: () => 0 });
    const uri = "harness-arena://competitions/live-cup/chat";

    expect(subscriptions.subscribe(uri)).toBe(true);
    expect(subscriptions.subscribe(uri)).toBe(true);
    await eventually(() => expect(client.readCompetitionChat).toHaveBeenCalledTimes(2));
    expect(client.readCompetitionChat).toHaveBeenNthCalledWith(1, expect.objectContaining({ competition_id: "live-cup", limit: 100, wait_seconds: 25 }));
    expect(client.readCompetitionChat).toHaveBeenNthCalledWith(2, expect.objectContaining({ after_cursor: "cursor-1" }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(uri);
    expect(JSON.stringify(notify.mock.calls)).not.toContain("safe-to-count-only");
    expect(subscriptions.workerCount).toBe(1);

    subscriptions.unsubscribe(uri);
    expect((client.readCompetitionChat.mock.calls[1][0] as { signal: AbortSignal }).signal.aborted).toBe(true);
    await subscriptions.close();
    expect(subscriptions.workerCount).toBe(0);
    resolveSecondRead({ page: { messages: [{ body: "untrusted participant text" }], next_cursor: "cursor-2" } });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("backs off boundedly after a failed poll without exposing an error payload", async () => {
    const client = { readCompetitionChat: vi.fn().mockRejectedValue(new Error("token=do-not-log")) };
    const notify = vi.fn();
    const subscriptions = new ChatSubscriptions({ client, notify, retryBaseMs: 2, retryMaxMs: 4, random: () => 0 });
    subscriptions.subscribe("harness-arena://competitions/live-cup/chat");
    await eventually(() => expect(client.readCompetitionChat).toHaveBeenCalledTimes(2));
    await subscriptions.close();
    expect(notify).not.toHaveBeenCalled();
    expect(subscriptions.workerCount).toBe(0);
  });
});
