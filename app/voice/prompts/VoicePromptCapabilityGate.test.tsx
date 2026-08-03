// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoicePromptCapabilityGate from "./VoicePromptCapabilityGate";

describe("VoicePromptCapabilityGate", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("renders no audio until same-origin capability bootstrap succeeds", async () => {
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<VoicePromptCapabilityGate><audio src="/api/voice/audio/prompts/p1" /></VoicePromptCapabilityGate>);
    expect(container.querySelector("audio")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/voice/capability", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    finish(new Response(null, { status: 204 }));
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
  });

  it("keeps audio unmounted and surfaces bootstrap failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const { container } = render(<VoicePromptCapabilityGate><audio src="/api/voice/audio/prompts/p1" /></VoicePromptCapabilityGate>);
    await screen.findByText(/could not authorize audio/i);
    expect(container.querySelector("audio")).toBeNull();
  });

  it.each([200, 201, 202])("keeps audio unmounted when bootstrap returns %i instead of 204", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    const { container } = render(<VoicePromptCapabilityGate><audio src="/api/voice/audio/prompts/p1" /></VoicePromptCapabilityGate>);
    await screen.findByText(/could not authorize audio/i);
    expect(container.querySelector("audio")).toBeNull();
  });
});
