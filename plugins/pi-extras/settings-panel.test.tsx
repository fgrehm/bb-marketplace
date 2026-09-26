import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiModelList } from "./model-scope";
import type { PiSettings } from "./pi-settings";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc }));

const { PiSettingsPanel } = await import("./settings-panel");

const MODELS: PiModelList["models"] = [
  { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5", contextWindow: 272_000, maxTokens: 128_000, reasoning: true, images: true },
  { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000, maxTokens: 128_000, reasoning: true, images: false },
  { provider: "opencode-go", id: "kimi-k2.6", name: null, contextWindow: 262_144, maxTokens: 262_144, reasoning: true, images: false },
];

function setup(settings: PiSettings, list: PiModelList = { models: MODELS, error: null }) {
  rpc.call.mockImplementation(async (name: string, input?: unknown) => {
    if (name === "listModels") return list;
    if (name === "readSettings") return settings;
    if (name === "writeSettings") return input;
    throw new Error(`unexpected call ${name}`);
  });
  return render(<PiSettingsPanel />);
}

const BASE: PiSettings = {
  defaultProvider: "openai-codex",
  defaultModel: "gpt-5.5",
  defaultThinkingLevel: "low",
  enabledModels: [],
};

describe("PiSettingsPanel", () => {
  afterEach(() => {
    cleanup();
    rpc.call.mockReset();
  });

  it("writes the provider and model id together for a selected model", async () => {
    setup(BASE);
    const select = await screen.findByRole("combobox", { name: /default model/i });
    fireEvent.change(select, { target: { value: "opencode-go/kimi-k2.6" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("writeSettings", {
      defaultProvider: "opencode-go",
      defaultModel: "kimi-k2.6",
      defaultThinkingLevel: "low",
      enabledModels: [],
    }));
  });

  it("keeps the default model first in the scope and warns that the scope wins", async () => {
    setup({ ...BASE, enabledModels: ["openai-codex/gpt-5.6-luna"] });
    const select = await screen.findByRole("combobox", { name: /default model/i });
    expect(select).toHaveProperty("value", "openai-codex/gpt-5.5");
    fireEvent.change(select, { target: { value: "opencode-go/kimi-k2.6" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("writeSettings", expect.objectContaining({
      enabledModels: ["opencode-go/kimi-k2.6", "openai-codex/gpt-5.6-luna"],
    })));
    expect(screen.getByText(/starts on its first entry/i)).not.toBeNull();
  });

  it("keeps a saved model that pi no longer lists, selected and unchanged", async () => {
    setup({ ...BASE, defaultModel: "gpt-4", defaultProvider: "openai" });
    const select = await screen.findByRole("combobox", { name: /default model/i });
    expect((select as HTMLSelectElement).value).toBe("(not available)");
    expect(screen.getByText(/is not in Pi's available list/)).not.toBeNull();
    expect(screen.getByRole("option", { name: /openai\/gpt-4 \(not in Pi/ })).not.toBeNull();
    // An unrelated edit must not drop the unavailable model.
    fireEvent.change(screen.getByRole("combobox", { name: /default thinking level/i }), {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("writeSettings", expect.objectContaining({
      defaultProvider: "openai",
      defaultModel: "gpt-4",
      defaultThinkingLevel: "high",
    })));
  });

  it("writes no scope when every model is selected", async () => {
    setup({ ...BASE, enabledModels: [] });
    await screen.findByRole("combobox", { name: /default model/i });
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("writeSettings", expect.objectContaining({
      enabledModels: [],
    })));
  });

  it("reports an unreadable model list and keeps values editable", async () => {
    setup(BASE, { models: [], error: "pi is not installed" });
    expect(await screen.findByText(/pi is not installed/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit provider and model as raw values" })).not.toBeNull();
  });

  it("surfaces unsafe and unresolved patterns without deleting them", async () => {
    setup({ ...BASE, enabledModels: ["!opencode-go/*", "openai-codex/gpt-4"] });
    await screen.findByRole("combobox", { name: /default model/i });
    expect(screen.getByRole("button", { name: "Remove pattern !opencode-go/*" })).not.toBeNull();
    expect(screen.getByText(/is not an exclusion syntax/i)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Remove pattern openai-codex\/gpt-4/ }));
    expect(screen.getByRole("button", { name: "Remove pattern !opencode-go/*" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Remove pattern openai-codex\/gpt-4/ })).toBeNull();
  });
});
