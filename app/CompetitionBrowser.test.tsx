// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Competition } from "@/lib/types";
import { CompetitionBrowser } from "./CompetitionBrowser";

afterEach(() => {
  cleanup();
});

function competition(overrides: Partial<Competition> = {}): Competition {
  return {
    id: "comp-one",
    arena: "harness-arena",
    harness: "pi",
    model: "zai/glm-5.2",
    gateway_provider: "baseten",
    status: "live",
    created_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("CompetitionBrowser", () => {
  it("disables navigation for an invalid parameter combination and re-enables it when valid", async () => {
    const user = userEvent.setup();
    const competitions = [
      competition(),
      competition({ id: "comp-two", model: "zai/glm-5.2-fast", gateway_provider: "wafer" }),
    ];

    render(<CompetitionBrowser competitions={competitions} selectedCompetition={competitions[0]} />);

    const model = screen.getByLabelText("Model");
    const provider = screen.getByLabelText("Provider");
    const button = screen.getByRole("button", { name: "View competition" });

    expect(button).toBeEnabled();
    await user.selectOptions(model, "zai/glm-5.2-fast");

    expect(screen.getByRole("button", { name: "No competition" })).toBeDisabled();
    expect(screen.getByText("No competition matches these parameters.")).toBeInTheDocument();

    await user.selectOptions(provider, "wafer");

    expect(screen.getByRole("button", { name: "View competition" })).toBeEnabled();
    expect(screen.queryByText("No competition matches these parameters.")).not.toBeInTheDocument();
  });
});
