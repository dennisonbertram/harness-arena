// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompletePromptModal } from "./CompletePromptModal";

afterEach(() => {
  cleanup();
});

describe("CompletePromptModal", () => {
  it("is closed by default and opens on trigger click, showing the complete prompt", async () => {
    const user = userEvent.setup();
    render(<CompletePromptModal prompt="the complete prompt text" isBaseline={false} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View complete system prompt" }));

    expect(screen.getByRole("dialog", { name: "Complete system prompt" })).toBeInTheDocument();
    expect(screen.getByText("the complete prompt text")).toBeInTheDocument();
  });

  it("explains the baseline case when isBaseline is true", async () => {
    const user = userEvent.setup();
    render(<CompletePromptModal prompt="pi's built-in default" isBaseline={true} />);

    await user.click(screen.getByRole("button", { name: "View complete system prompt" }));

    expect(screen.getByText(/no custom prompt was submitted/)).toBeInTheDocument();
  });

  it("explains the custom-prompt case when isBaseline is false", async () => {
    const user = userEvent.setup();
    render(<CompletePromptModal prompt="custom" isBaseline={false} />);

    await user.click(screen.getByRole("button", { name: "View complete system prompt" }));

    expect(screen.getByText(/the submitted text plus pi's working-directory line/)).toBeInTheDocument();
  });

  it("closes via the close button", async () => {
    const user = userEvent.setup();
    render(<CompletePromptModal prompt="p" isBaseline={false} />);
    await user.click(screen.getByRole("button", { name: "View complete system prompt" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes when clicking the backdrop, but not when clicking inside the dialog content", async () => {
    const user = userEvent.setup();
    render(<CompletePromptModal prompt="p" isBaseline={false} />);
    await user.click(screen.getByRole("button", { name: "View complete system prompt" }));

    await user.click(screen.getByText("Complete system prompt"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape while open", async () => {
    const user = userEvent.setup();
    render(<CompletePromptModal prompt="p" isBaseline={false} />);
    await user.click(screen.getByRole("button", { name: "View complete system prompt" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not attach a keydown listener while closed (Escape is a no-op before opening)", async () => {
    const user = userEvent.setup();
    render(<CompletePromptModal prompt="p" isBaseline={false} />);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("removes its keydown listener on unmount without throwing", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CompletePromptModal prompt="p" isBaseline={false} />);
    await user.click(screen.getByRole("button", { name: "View complete system prompt" }));

    expect(() => unmount()).not.toThrow();
  });
});
