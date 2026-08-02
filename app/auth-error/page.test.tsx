import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AuthErrorPage from "./page";

describe("AuthErrorPage", () => {
  it("maps a known Auth.js error code to its plain-copy message", async () => {
    const html = renderToStaticMarkup(await AuthErrorPage({ searchParams: Promise.resolve({ error: "AccessDenied" }) }));

    expect(html).toContain("Sign-in was cancelled.");
  });

  it("falls back to the default message for an unrecognized error value, and never renders it verbatim", async () => {
    const attackerValue = "<script>alert(1)</script>";
    const html = renderToStaticMarkup(
      await AuthErrorPage({ searchParams: Promise.resolve({ error: attackerValue }) }),
    );

    expect(html).toContain("Sign-in didn&#x27;t complete.");
    expect(html).not.toContain(attackerValue);
    expect(html).not.toContain("alert(1)");
  });

  it("falls back to the default message when there is no error param at all", async () => {
    const html = renderToStaticMarkup(await AuthErrorPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Sign-in didn&#x27;t complete.");
  });
});
