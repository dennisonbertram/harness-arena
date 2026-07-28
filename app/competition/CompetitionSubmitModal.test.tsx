// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompetitionSubmitModal } from "./CompetitionSubmitModal";

// jsdom (as of the version pinned here) doesn't implement
// HTMLDialogElement.showModal()/close(), nor the browser's native
// "Escape closes the topmost open modal <dialog>" behavior. This is a
// test-only polyfill of that native behavior so the component's real
// showModal()/close() calls -- and the resulting "close" event the
// component listens to -- can be exercised. It does not touch the
// component's source.
beforeAll(() => {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
      const onKeydown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          this.close();
        }
      };
      (this as unknown as { __onEscKeydown?: (e: KeyboardEvent) => void }).__onEscKeydown = onKeydown;
      document.addEventListener("keydown", onKeydown);
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      const handler = (this as unknown as { __onEscKeydown?: (e: KeyboardEvent) => void }).__onEscKeydown;
      if (handler) {
        document.removeEventListener("keydown", handler);
      }
      this.dispatchEvent(new Event("close"));
    };
  }
});

afterEach(() => {
  cleanup();
});

// getByRole's default visibility filter (hidden: false) calls
// window.getComputedStyle on every candidate and its ancestors, and jsdom
// 30 throws parsing this component's `width: min(640px, calc(...))` inline
// style. `{ hidden: true }` skips that filter -- open/closed state is
// asserted directly on the `open` attribute instead, so nothing is lost.
const HIDDEN = { hidden: true } as const;

describe("CompetitionSubmitModal", () => {
  it("opens the dialog via showModal when the trigger is clicked", async () => {
    const user = userEvent.setup();
    render(
      <CompetitionSubmitModal>
        <p>form contents</p>
      </CompetitionSubmitModal>,
    );

    expect(screen.getByRole("dialog", HIDDEN)).not.toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: "Submit a prompt", ...HIDDEN }));

    expect(screen.getByRole("dialog", HIDDEN)).toHaveAttribute("open");
    expect(screen.getByText("form contents")).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the trigger button", async () => {
    const user = userEvent.setup();
    render(
      <CompetitionSubmitModal>
        <p>form contents</p>
      </CompetitionSubmitModal>,
    );

    const trigger = screen.getByRole("button", { name: "Submit a prompt", ...HIDDEN });
    await user.click(trigger);
    expect(screen.getByRole("dialog", HIDDEN)).toHaveAttribute("open");

    await user.keyboard("{Escape}");

    expect(screen.getByRole("dialog", HIDDEN)).not.toHaveAttribute("open");
    expect(trigger).toHaveFocus();
  });

  it("closes via the in-dialog close button and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <CompetitionSubmitModal>
        <p>form contents</p>
      </CompetitionSubmitModal>,
    );

    const trigger = screen.getByRole("button", { name: "Submit a prompt", ...HIDDEN });
    await user.click(trigger);
    expect(screen.getByRole("dialog", HIDDEN)).toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: "Close submission dialog", ...HIDDEN }));

    expect(screen.getByRole("dialog", HIDDEN)).not.toHaveAttribute("open");
    expect(trigger).toHaveFocus();
  });
});
