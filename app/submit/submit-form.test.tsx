// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubmitForm } from "./submit-form";

const SYSTEM_PROMPT_LABEL = /^System prompt/;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, prompt = "be helpful") {
  await user.type(screen.getByLabelText("Agent name"), "my-agent");
  await user.type(screen.getByLabelText(SYSTEM_PROMPT_LABEL), prompt);
  await user.click(screen.getByRole("button", { name: "Submit Prompt" }));
}

describe("SubmitForm", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("posts the selected model and shows a successful submission with its judge reason and run link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { submission_id: "sub-1", run_id: "run-1", status: "accepted", judge_reason: "Looks fair." }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SubmitForm githubLogin="octocat" />);

    await user.selectOptions(screen.getByRole("combobox"), "anthropic/claude-opus-4-8");
    expect(screen.getByText(/most expensive model/)).toBeInTheDocument();
    await fillAndSubmit(user);

    expect(await screen.findByText("sub-1")).toBeInTheDocument();
    expect(screen.getByText("Looks fair.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View run/ })).toHaveAttribute("href", "/runs/run-1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      agent_name: "my-agent",
      prompt: "be helpful",
      model: "anthropic/claude-opus-4-8",
    });
  });

  it("shows the fairness-judge rejection and its reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { status: "rejected", judge_reason: "Reads fixtures." })));
    const user = userEvent.setup();
    render(<SubmitForm githubLogin="octocat" />);
    await fillAndSubmit(user);

    expect(await screen.findByText("Submission rejected by the fairness judge")).toBeInTheDocument();
    expect(screen.getByText("Reads fixtures.")).toBeInTheDocument();
  });

  it("shows the parser's default rejection reason when none is returned", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { status: "rejected" })));
    const user = userEvent.setup();
    render(<SubmitForm githubLogin="octocat" />);
    await fillAndSubmit(user);

    expect(await screen.findByText("The fairness judge rejected this prompt.")).toBeInTheDocument();
  });

  it("shows the server error for a duplicate response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(409, { error: "You already submitted this prompt." })));
    const user = userEvent.setup();
    render(<SubmitForm githubLogin="octocat" />);
    await fillAndSubmit(user);

    expect(await screen.findByText("Couldn’t submit")).toBeInTheDocument();
    expect(screen.getByText("You already submitted this prompt.")).toBeInTheDocument();
  });

  it("shows the reauthentication prompt on a session-expired response and preserves the prompt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "Session expired." })));
    const user = userEvent.setup();
    render(<SubmitForm githubLogin="octocat" />);
    await fillAndSubmit(user, "keep this prompt");

    expect(await screen.findByText("Your session expired")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Sign in again/ })).toHaveAttribute("href", "/submit");
    expect(screen.getByLabelText(SYSTEM_PROMPT_LABEL)).toHaveValue("keep this prompt");
  });

  it("shows a generic parser fallback for a non-JSON server error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new Error("html")) } as Response));
    const user = userEvent.setup();
    render(<SubmitForm githubLogin="octocat" />);
    await fillAndSubmit(user);

    expect(await screen.findByText("The server returned HTTP 500.")).toBeInTheDocument();
  });

  it("shows the network error when submitting throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const user = userEvent.setup();
    render(<SubmitForm githubLogin="octocat" />);
    await fillAndSubmit(user);

    expect(await screen.findByText("Could not reach the server. Try again.")).toBeInTheDocument();
  });

  it("loads the baseline prompt and leaves existing text alone when that request fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("baseline instructions") } as Response)
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SubmitForm githubLogin="octocat" />);

    await user.click(screen.getByRole("button", { name: "Start from the baseline prompt" }));
    await waitFor(() => expect(screen.getByLabelText(SYSTEM_PROMPT_LABEL)).toHaveValue("baseline instructions"));
    await user.click(screen.getByRole("button", { name: "Start from the baseline prompt" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start from the baseline prompt" })).toBeEnabled());
    expect(screen.getByLabelText(SYSTEM_PROMPT_LABEL)).toHaveValue("baseline instructions");
  });
});
