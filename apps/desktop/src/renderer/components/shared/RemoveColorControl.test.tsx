import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../config/copy";
import { RemoveColorControl } from "./RemoveColorControl";

// "− Remove colour" (owner, 27 Nov 2026): pick one of the article's colours, read what happens, confirm. The main
// process decides; its refusal is shown in its own words and nothing is claimed removed.

const words = copy.removeColour;
let api: { removeArticleColor: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = { removeArticleColor: vi.fn() };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

const open = async (onRemoved = vi.fn()) => {
  render(<RemoveColorControl article="SK6" colours={["BLACK", "RED"]} onRemoved={onRemoved} />);
  await userEvent.click(screen.getByRole("button", { name: words.buttonLabel("SK6") }));
  return onRemoved;
};

describe("Remove colour", () => {
  it("waits for a colour to be chosen, says what will happen, and removes it", async () => {
    api.removeArticleColor.mockResolvedValue({ accepted: true, color: "BLACK", removed: 3 });
    const onRemoved = await open();
    expect(screen.getByRole("button", { name: words.confirm("colour") })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /BLACK/ }));
    expect(screen.getByText(words.explain("SK6", "BLACK"))).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: words.confirm("BLACK") }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith("BLACK"));
    expect(api.removeArticleColor).toHaveBeenCalledWith({ article: "SK6", color: "BLACK" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("shows the main process's refusal in its words and keeps the dialog open", async () => {
    const reason = "SK6 BLACK still has carton stock: 10/13 (1.5 dozen). Take it to zero with a Stock Adjustment first.";
    api.removeArticleColor.mockResolvedValue({ accepted: false, reason });
    const onRemoved = await open();
    await userEvent.click(screen.getByRole("radio", { name: /BLACK/ }));
    await userEvent.click(screen.getByRole("button", { name: words.confirm("BLACK") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
    expect(onRemoved).not.toHaveBeenCalled();
  });
});
