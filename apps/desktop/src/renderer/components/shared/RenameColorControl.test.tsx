import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../config/copy";
import { RenameColorControl } from "./RenameColorControl";

// "Rename colour" (owner, 28 Nov 2026): pick one of the article's colours, fix its name in place, confirm. The main
// process decides; its refusal is shown in its own words and nothing is claimed renamed.

const words = copy.renameColour;
let api: { renameArticleColor: ReturnType<typeof vi.fn> };

beforeEach(() => {
  api = { renameArticleColor: vi.fn() };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

const open = async (onRenamed = vi.fn()) => {
  render(<RenameColorControl article="SK6" colours={["BOWN", "RED"]} onRenamed={onRenamed} />);
  await userEvent.click(screen.getByRole("button", { name: words.buttonLabel("SK6") }));
  return onRenamed;
};

describe("Rename colour", () => {
  it("fills the box with the chosen colour's name, waits for a change, and renames it", async () => {
    api.renameArticleColor.mockResolvedValue({ accepted: true, from: "BOWN", color: "BROWN", renamed: 3 });
    const onRenamed = await open();
    expect(screen.queryByLabelText(words.newName)).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: /BOWN/ }));
    const box = screen.getByLabelText(words.newName) as HTMLInputElement;
    expect(box.value).toBe("BOWN");
    expect(screen.getByRole("button", { name: words.confirm })).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, "brown{Enter}");
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("BROWN"));
    expect(api.renameArticleColor).toHaveBeenCalledWith({ article: "SK6", from: "BOWN", to: "brown" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("shows the main process's refusal in its words and keeps the dialog open", async () => {
    const reason = "SK6 already has RED. Two colours cannot be joined by a rename. Nothing was changed.";
    api.renameArticleColor.mockResolvedValue({ accepted: false, reason });
    const onRenamed = await open();
    await userEvent.click(screen.getByRole("radio", { name: /BOWN/ }));
    const box = screen.getByLabelText(words.newName);
    await userEvent.clear(box);
    await userEvent.type(box, "red");
    await userEvent.click(screen.getByRole("button", { name: words.confirm }));
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
    expect(onRenamed).not.toHaveBeenCalled();
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
  });
});
