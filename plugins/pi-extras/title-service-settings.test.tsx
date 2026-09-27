import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PiModelList } from "./model-scope";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc }));
const { TitleServiceSettings } = await import("./title-service-settings");

const models: PiModelList["models"] = [
  { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000, maxTokens: 128_000, reasoning: true, images: false },
  { provider: "opencode-go", id: "kimi-k2.6", name: null, contextWindow: 262_144, maxTokens: 262_144, reasoning: true, images: false },
];

function setup(titleModel = "", status: { ready: true } | { ready: false; message: string } = { ready: true }) {
  rpc.call.mockImplementation(async (method: string, input?: unknown) => {
    if (method === "readTitleSettings") return { titleModel };
    if (method === "writeTitleSettings") return input;
    if (method === "titleServiceStatus") return status;
    throw new Error(`unexpected call ${method}`);
  });
  render(<TitleServiceSettings models={models} />);
}

afterEach(() => { cleanup(); rpc.call.mockReset(); });

it("shows readiness and tells the user to select Pi in BB", async () => {
  setup();
  expect(await screen.findByText(/ready to name threads/i)).toBeTruthy();
  expect(screen.getByText(/AI services/i)).toBeTruthy();
});

it("reports why Pi cannot answer", async () => {
  setup("", { ready: false, message: "Sign in with /login" });
  expect(await screen.findByText(/sign in with \/login/i)).toBeTruthy();
});

it("uses Pi default, lists available models, and preserves a missing saved model", async () => {
  setup("retired/model-1");
  const select = (await screen.findByLabelText(/model for thread titles/i)) as HTMLSelectElement;
  expect(select.value).toBe("retired/model-1");
  expect(Array.from(select.options).map((option) => option.value)).toEqual([
    "", "openai-codex/gpt-5.6-luna", "opencode-go/kimi-k2.6", "retired/model-1",
  ]);
});

it("saves the chosen model and can reset to Pi default", async () => {
  setup("openai-codex/gpt-5.6-luna");
  const select = (await screen.findByLabelText(/model for thread titles/i)) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "opencode-go/kimi-k2.6" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("writeTitleSettings", { titleModel: "opencode-go/kimi-k2.6" }));
  fireEvent.change(select, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("writeTitleSettings", { titleModel: "" }));
});
