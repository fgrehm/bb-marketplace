// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";

afterEach(cleanup);

const message: PluginMessageDirectiveProps["message"] = {
  id: "msg-current",
  threadId: "thread-1",
  turnId: "turn-1",
  projectId: "project-1",
};
const props = { message, attributes: {}, source: "", openWorkspaceFile: null };
const eligible = { lazy_reply_eligible: async () => ({ eligible: true }) };
async function renderReply(options: RenderSlotOptions<typeof rpcContract>) {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.messageDirectives[0]!, props, options);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Lazy Chat reply directive", () => {
  it("shares edits with the matching native thread composer and refuses queued scope", async () => {
    const slot = await renderReply({
      rpc: eligible,
      context: { threadId: message.threadId },
      composer: {
        text: "native draft",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    expect((editor as HTMLTextAreaElement).value).toBe("native draft");
    fireEvent.change(editor, { target: { value: "inline edit" } });
    await waitFor(() =>
      expect(slot.inspection.composer.text).toBe("inline edit"),
    );
    await slot.behavior.setComposerScope({
      kind: "queued-message",
      threadId: message.threadId,
      queuedMessageId: "queued-1",
    });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /unavailable/i,
    );
    expect(slot.inspection.composer.text).toBe("inline edit");
    slot.lifecycle.unmount();
  });

  it("inserts quotes and submits only after an eligibility recheck", async () => {
    const slot = await renderReply({
      rpc: eligible,
      context: { threadId: message.threadId },
      composer: {
        text: "draft",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.click(screen.getByRole("button", { name: "Insert quote probe" }));
    await waitFor(() =>
      expect(slot.inspection.composer.quotes).toEqual([
        "Lazy Chat quote probe",
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(slot.inspection.composer.submits).toHaveLength(1),
    );
    slot.lifecycle.unmount();
  });

  it.each(["edit", "quote", "submit"] as const)(
    "cancels a pending %s when newer thread activity arrives",
    async (action) => {
      let activityOccurred = false;
      let initialCheck = true;
      const pending: ReturnType<typeof deferred<{ eligible: boolean }>>[] = [];
      const slot = await renderReply({
        rpc: {
          lazy_reply_eligible: () => {
            if (initialCheck) {
              initialCheck = false;
              return Promise.resolve({ eligible: true });
            }
            if (activityOccurred) return Promise.resolve({ eligible: false });
            const check = deferred<{ eligible: boolean }>();
            pending.push(check);
            return check.promise;
          },
        },
        context: { threadId: message.threadId },
        composer: {
          text: "known shared draft",
          scope: { kind: "thread", threadId: message.threadId },
        },
      });
      const editor = await screen.findByRole("textbox", {
        name: "Reply draft",
      });
      if (action === "edit")
        fireEvent.change(editor, { target: { value: "stale edit" } });
      if (action === "quote")
        fireEvent.click(
          screen.getByRole("button", { name: "Insert quote probe" }),
        );
      if (action === "submit")
        fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
      await waitFor(() => expect(pending).toHaveLength(1));

      activityOccurred = true;
      await slot.behavior.emitRealtime("thread-activity", {
        threadId: message.threadId,
        sequence: 2,
      });
      expect(screen.queryByRole("textbox", { name: "Reply draft" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Insert quote probe" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Send reply" })).toBeNull();
      await act(async () => {
        pending[0]!.resolve({ eligible: true });
        await Promise.resolve();
      });
      await screen.findByRole("status");

      expect(slot.inspection.composer.text).toBe("known shared draft");
      expect(slot.inspection.composer.quotes).toEqual([]);
      expect(slot.inspection.composer.submits).toHaveLength(0);
      slot.lifecycle.unmount();
    },
  );

  it("refuses submission if eligibility expires after rendering", async () => {
    let checks = 0;
    const slot = await renderReply({
      rpc: {
        lazy_reply_eligible: async () => ({ eligible: ++checks === 1 }),
      },
      context: { threadId: message.threadId },
      composer: {
        text: "draft",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByRole("status");
    expect(slot.inspection.composer.submits).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("does not apply a pending edit after the composer switches threads", async () => {
    const checks: ReturnType<typeof deferred<{ eligible: boolean }>>[] = [];
    const slot = await renderReply({
      rpc: {
        lazy_reply_eligible: () => {
          const check = deferred<{ eligible: boolean }>();
          checks.push(check);
          return check.promise;
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "original draft",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    await waitFor(() => expect(checks).toHaveLength(1));
    checks[0]!.resolve({ eligible: true });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "pending old-thread edit" } });
    await waitFor(() => expect(checks).toHaveLength(2));

    await slot.behavior.setComposerScope({
      kind: "thread",
      threadId: "thread-2",
    });
    await slot.behavior.setComposerText("new thread draft");
    await act(async () => {
      checks[1]!.resolve({ eligible: true });
      await checks[1]!.promise;
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toMatch(/unavailable/i);
    expect(slot.inspection.composer.text).toBe("new thread draft");
    expect(slot.inspection.composer.submits).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("preserves a newer native composer edit while inline authorization is pending", async () => {
    const pending = deferred<{ eligible: boolean }>();
    let calls = 0;
    const slot = await renderReply({
      rpc: {
        lazy_reply_eligible: () =>
          ++calls === 1 ? Promise.resolve({ eligible: true }) : pending.promise,
      },
      context: { threadId: message.threadId },
      composer: {
        text: "original draft",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "pending inline edit" } });
    await waitFor(() => expect(calls).toBe(2));

    await slot.behavior.setComposerText("newer native text");
    await waitFor(() =>
      expect((editor as HTMLTextAreaElement).value).toBe("newer native text"),
    );
    await act(async () => {
      pending.resolve({ eligible: true });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(slot.inspection.composer.text).toBe("newer native text"),
    );
    expect((editor as HTMLTextAreaElement).value).toBe("newer native text");
    slot.lifecycle.unmount();
  });

  it("does not write a pending inline edit after unmount", async () => {
    const pending = deferred<{ eligible: boolean }>();
    let calls = 0;
    const slot = await renderReply({
      rpc: {
        lazy_reply_eligible: () =>
          ++calls === 1 ? Promise.resolve({ eligible: true }) : pending.promise,
      },
      context: { threadId: message.threadId },
      composer: {
        text: "original draft",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "pending inline edit" } });
    await waitFor(() => expect(calls).toBe(2));

    slot.lifecycle.unmount();
    await act(async () => {
      pending.resolve({ eligible: true });
      await Promise.resolve();
    });
    expect(slot.inspection.composer.text).toBe("original draft");
  });

  it("does not let an older eligibility result overwrite a newer valid edit", async () => {
    const checks: ReturnType<typeof deferred<{ eligible: boolean }>>[] = [];
    const slot = await renderReply({
      rpc: {
        lazy_reply_eligible: () => {
          const check = deferred<{ eligible: boolean }>();
          checks.push(check);
          return check.promise;
        },
      },
      context: { threadId: message.threadId },
      composer: {
        text: "original draft",
        scope: { kind: "thread", threadId: message.threadId },
      },
    });
    await waitFor(() => expect(checks).toHaveLength(1));
    checks[0]!.resolve({ eligible: true });
    const editor = await screen.findByRole("textbox", { name: "Reply draft" });
    fireEvent.change(editor, { target: { value: "older edit" } });
    fireEvent.change(editor, { target: { value: "latest edit" } });
    await waitFor(() => expect(checks).toHaveLength(3));

    checks[2]!.resolve({ eligible: true });
    await waitFor(() =>
      expect(slot.inspection.composer.text).toBe("latest edit"),
    );
    await act(async () => {
      checks[1]!.resolve({ eligible: true });
      await Promise.resolve();
    });
    expect(slot.inspection.composer.text).toBe("latest edit");
    expect((editor as HTMLTextAreaElement).value).toBe("latest edit");
    slot.lifecycle.unmount();
  });

  it("does not render an editor in a mismatched thread scope", async () => {
    await renderReply({
      rpc: eligible,
      context: { threadId: message.threadId },
      composer: {
        text: "other thread draft",
        scope: { kind: "thread", threadId: "thread-2" },
      },
    });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /unavailable/i,
    );
    expect(screen.queryByRole("textbox", { name: "Reply draft" })).toBeNull();
  });
});
