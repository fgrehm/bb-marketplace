import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { UpdateActions } from "./update-actions";

describe("UpdateActions", () => {
  afterEach(() => cleanup());
  it("reports the selected update and disables both actions while busy", () => {
    const onUpdate = vi.fn();
    render(<UpdateActions updating={"models"} onUpdate={onUpdate} />);
    expect(screen.getByRole("button", { name: "Refreshing..." })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Update plugins" })).toHaveProperty("disabled", true);
  });
  it("calls the requested update", () => {
    const onUpdate = vi.fn();
    render(<UpdateActions updating={null} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole("button", { name: "Update plugins" }));
    expect(onUpdate).toHaveBeenCalledWith("plugins");
  });
});
