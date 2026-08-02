// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubmitCompetitionForm } from "./SubmitCompetitionForm";

// The "System prompt" label wraps both the textarea and a running character
// count ("0/32768"), so its full accessible text isn't the plain label
// string -- match on the label prefix instead.
const SYSTEM_PROMPT_LABEL = /^System prompt/;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, agentName = "my-agent", prompt = "be nice") {
  await user.type(screen.getByLabelText("Agent name"), agentName);
  await user.type(screen.getByLabelText(SYSTEM_PROMPT_LABEL), prompt);
  await user.click(screen.getByRole("button", { name: "Submit Prompt" }));
}

describe("SubmitCompetitionForm", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("handleSubmit outcomes", () => {
    it("shows the success message with submission id, status, and a link when a run_id is present", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(200, { submission_id: "sub-1", run_id: "run-1", status: "accepted" }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" competitionId="comp-1" />);
      await fillAndSubmit(user);

      expect(await screen.findByText("sub-1")).toBeInTheDocument();
      expect(screen.getByText("accepted")).toBeInTheDocument();
      const link = screen.getByRole("link", { name: /View run/ });
      expect(link).toHaveAttribute("href", "/runs/run-1");
    });

    it("omits the run link when the success response has no run_id", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { submission_id: "sub-2", status: "accepted" }));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user);

      expect(await screen.findByText("sub-2")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /View run/ })).not.toBeInTheDocument();
    });

    it("treats a 200 with status: rejected as a judge rejection and shows the judge_reason", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(200, { status: "rejected", judge_reason: "Prompt tries to read task fixtures." }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user);

      expect(await screen.findByText("Submission rejected by the fairness judge")).toBeInTheDocument();
      expect(screen.getByText("Prompt tries to read task fixtures.")).toBeInTheDocument();
    });

    it("falls back to a default judge_reason when the rejection response omits one", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: "rejected" }));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user);

      expect(await screen.findByText("The fairness judge rejected this prompt.")).toBeInTheDocument();
    });

    it("shows the duplicate message on a 409", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(409, { error: "You already have an entry." }));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user);

      expect(await screen.findByText("Prompt already submitted")).toBeInTheDocument();
      expect(screen.getByText("You already have an entry.")).toBeInTheDocument();
    });

    it("falls back to a default message on a 409 with no error field", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(409, {}));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user);

      expect(await screen.findByText("This prompt has already been submitted.")).toBeInTheDocument();
    });

    it("shows the session-expired message with a sign-in link on a 401, preserving the typed prompt", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Session expired." }));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user, "my-agent", "keep this prompt");

      // Note: the component captures body.error into outcome.message for the
      // session-expired case but never renders it -- only the fixed copy
      // below is shown. Asserting the fixed copy plus the sign-in link and
      // the still-present prompt is what's actually observable here.
      expect(await screen.findByText("Your session expired")).toBeInTheDocument();
      expect(screen.getByText(/Your prompt is still here/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Sign in again/ })).toHaveAttribute("href", "/");
      // The prompt textarea still holds what was typed.
      expect(screen.getByLabelText(SYSTEM_PROMPT_LABEL)).toHaveValue("keep this prompt");
    });

    it("also reaches the session-expired branch on a 401 with no error field", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, {}));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user);

      expect(await screen.findByText("Your session expired")).toBeInTheDocument();
    });

    it("shows a generic error with the server's message for any other non-ok status", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { error: "Judge service is down." }));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user);

      expect(await screen.findByText("Couldn't submit")).toBeInTheDocument();
      expect(screen.getByText("Judge service is down.")).toBeInTheDocument();
    });

    it("falls back to an HTTP-status message for a generic error with no error field", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, null));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user);

      expect(await screen.findByText("The server returned HTTP 500.")).toBeInTheDocument();
    });

    it("treats an unparsable JSON body as null and still renders success from an empty result", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("not json")),
      } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user);

      await waitFor(() => expect(document.body.textContent).toContain("— status:"));
    });

    it("shows the network-error message when fetch throws", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user);

      expect(await screen.findByText("Could not reach the server. Try again.")).toBeInTheDocument();
    });
  });

  describe("POST body wiring", () => {
    it("sends agent_name, prompt, and competition_id when competitionId is provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { submission_id: "s", status: "accepted" }));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" competitionId="comp-42" />);
      await fillAndSubmit(user, "agent-x", "prompt-x");

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/competition/submissions");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ agent_name: "agent-x", prompt: "prompt-x", competition_id: "comp-42" });
    });

    it("omits competition_id from the JSON body when the prop is not provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { submission_id: "s", status: "accepted" }));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await fillAndSubmit(user, "agent-y", "prompt-y");

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ agent_name: "agent-y", prompt: "prompt-y" });
      expect(Object.prototype.hasOwnProperty.call(body, "competition_id")).toBe(false);
    });
  });

  describe("loadBaseline", () => {
    it("populates the prompt box with the baseline text on success", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("baseline system prompt text"),
      } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      await user.click(screen.getByRole("button", { name: "Start from the baseline prompt" }));

      await waitFor(() => expect(screen.getByLabelText(SYSTEM_PROMPT_LABEL)).toHaveValue("baseline system prompt text"));
      expect(fetchMock).toHaveBeenCalledWith("/api/baseline-prompt");
    });

    it("leaves the prompt box untouched when the baseline fetch responds not-ok", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      const textarea = screen.getByLabelText(SYSTEM_PROMPT_LABEL);
      await user.type(textarea, "already typed");
      await user.click(screen.getByRole("button", { name: "Start from the baseline prompt" }));

      await waitFor(() => expect(screen.getByRole("button", { name: "Start from the baseline prompt" })).toBeEnabled());
      expect(textarea).toHaveValue("already typed");
    });

    it("leaves the prompt box untouched when the baseline fetch throws", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(<SubmitCompetitionForm githubLogin="octocat" />);
      const textarea = screen.getByLabelText(SYSTEM_PROMPT_LABEL);
      await user.type(textarea, "still here");
      await user.click(screen.getByRole("button", { name: "Start from the baseline prompt" }));

      await waitFor(() => expect(screen.getByRole("button", { name: "Start from the baseline prompt" })).toBeEnabled());
      expect(textarea).toHaveValue("still here");
    });
  });

  it("renders the signed-in github login", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<SubmitCompetitionForm githubLogin="octocat" />);
    expect(screen.getByText("octocat")).toBeInTheDocument();
  });
});
