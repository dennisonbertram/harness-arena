// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RerunButton } from "./RerunButton";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("RerunButton", () => {
  it("confirms, posts the exact entry, and links to the queued run on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { run_id: "run-42" }));
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", confirmMock);
    const user = userEvent.setup();

    render(<RerunButton agentName="agent-x" prompt="repeat this prompt" model="gpt-test" />);
    await user.click(screen.getByRole("button", { name: "Rerun" }));

    expect(confirmMock).toHaveBeenCalledWith('Rerun "agent-x" with the same prompt? This starts a new paid run.');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_name: "agent-x", prompt: "repeat this prompt", model: "gpt-test" }),
    });
    expect(await screen.findByRole("link", { name: "queued →" })).toHaveAttribute("href", "/runs/run-42");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not submit when the confirmation is declined", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    const user = userEvent.setup();

    render(<RerunButton agentName="agent-x" prompt="repeat this prompt" />);
    await user.click(screen.getByRole("button", { name: "Rerun" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rerun" })).toBeEnabled();
  });

  it("shows a retry state with the server error when no run is created", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, { error: "Judge service is down." }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const user = userEvent.setup();

    render(<RerunButton agentName="agent-x" prompt="repeat this prompt" />);
    await user.click(screen.getByRole("button", { name: "Rerun" }));

    const retry = await screen.findByRole("button", { name: "retry" });
    expect(retry).toHaveAttribute("title", "Judge service is down.");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ agent_name: "agent-x", prompt: "repeat this prompt" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the network-error retry state when the POST rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const user = userEvent.setup();

    render(<RerunButton agentName="agent-x" prompt="repeat this prompt" />);
    await user.click(screen.getByRole("button", { name: "Rerun" }));

    expect(await screen.findByRole("button", { name: "retry" })).toHaveAttribute(
      "title",
      "Could not reach the server.",
    );
  });
});
