import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PiModelList } from "./model-scope";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc }));
const { TextServiceSettings } = await import("./title-service-settings");

const models: PiModelList["models"] = [
  { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000, maxTokens: 128_000, reasoning: true, images: false },
  { provider: "opencode-go", id: "kimi-k2.6", name: null, contextWindow: 262_144, maxTokens: 262_144, reasoning: true, images: false },
];

function setup(
  titleModel = "",
  commitModel = "",
  status: { ready: true } | { ready: false; message: string } = { ready: true },
) {
  rpc.call.mockImplementation(async (method: string, input?: unknown) => {
    if (method === "readTitleSettings") return { titleModel, commitModel };
    if (method === "writeTitleSettings") return input;
    if (method === "titleServiceStatus") return status;
    throw new Error(`unexpected call ${method}`);
  });
  render(<TextServiceSettings models={models} />);
}

afterEach(() => { cleanup(); rpc.call.mockReset(); });

it("shows readiness and tells the user to select Pi in BB", async () => {
  setup();
  expect(await screen.findByText(/Pi is ready/i)).toBeTruthy();
  expect(screen.getByText(/AI services/i)).toBeTruthy();
});

it("reports why Pi cannot answer", async () => {
  setup("", "", { ready: false, message: "Sign in with /login" });
  expect(await screen.findByText(/sign in with \/login/i)).toBeTruthy();
});

it("lists models for both tasks and preserves missing saved models", async () => {
  setup("retired/title-model", "retired/commit-model");
  const titleSelect = (await screen.findByLabelText(/model for thread titles/i)) as HTMLSelectElement;
  const commitSelect = screen.getByLabelText(/model for commit messages/i) as HTMLSelectElement;
  expect(titleSelect.value).toBe("retired/title-model");
  expect(commitSelect.value).toBe("retired/commit-model");
  expect(Array.from(titleSelect.options).map((option) => option.value)).toEqual([
    "", "openai-codex/gpt-5.6-luna", "opencode-go/kimi-k2.6", "retired/title-model", "retired/commit-model",
  ]);
});

it("saves both models and can reset them to their defaults", async () => {
  setup("openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-luna");
  const titleSelect = (await screen.findByLabelText(/model for thread titles/i)) as HTMLSelectElement;
  const commitSelect = screen.getByLabelText(/model for commit messages/i) as HTMLSelectElement;
  fireEvent.change(titleSelect, { target: { value: "opencode-go/kimi-k2.6" } });
  fireEvent.change(commitSelect, { target: { value: "opencode-go/kimi-k2.6" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("writeTitleSettings", {
    titleModel: "opencode-go/kimi-k2.6", commitModel: "opencode-go/kimi-k2.6",
  }));
  fireEvent.change(titleSelect, { target: { value: "" } });
  fireEvent.change(commitSelect, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("writeTitleSettings", {
    titleModel: "", commitModel: "",
  }));
});
