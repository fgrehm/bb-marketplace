// @vitest-environment jsdom
Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView ?? (() => {});
import { describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("@/components/ui/icon", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: any) => (
    <>
      <div
        data-testid="pierre-diff"
        data-expand-unchanged={String(props.options.expandUnchanged)}
        data-hunk-separators={props.options.hunkSeparators}
      />
      <div
        onPointerUp={() =>
          props.options.onLineSelectionEnd?.({
            start: 1,
            end: 1,
            side: "additions",
          })
        }
      >
        {(props.lineAnnotations ?? []).map((la: any, index: number) => (
          <div key={`${la.lineNumber}-${index}`} data-line={la.lineNumber}>
            {la.metadata && "id" in la.metadata ? (
              <div data-annotation-id={la.metadata.id} />
            ) : null}
            {la.metadata && "entityMarker" in la.metadata ? (
              <div data-entity-anchor={la.metadata.entityId} />
            ) : null}
            {props.renderAnnotation?.(la)}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => void props.options.loadDiffFiles?.({})}
      >
        Load context
      </button>
    </>
  ),
}));

const patch = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 context
-old
+new
 context
`;

function reviewFixture() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    threadId: "thread-ui",
    snapshot: "snapshot-ui",
    createdAt: 1,
    target: { type: "uncommitted" },
    files: [
      {
        path: "src/example.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
        patch,
        truncated: false,
      },
    ],
    annotations: [],
    viewedPaths: [],
    summary: null,
  };
}

describe("Review Workspace app", () => {
  it("registers the header control and navigates to the review panel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, {
      threadId: "thread-ui",
      projectId: "project-ui",
      isCompactViewport: false,
    });

    slot.getByRole("button", { name: "Review" }).click();
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "review",
      options: { subPath: "review/thread-ui" },
    });

    const Header = app.threadHeaderActions[0]!.component;
    slot.rerender(
      <Header threadId="thread-ui" projectId="project-ui" isCompactViewport />,
    );
    expect(slot.queryByRole("button", { name: "Review" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps collapsed context expandable through Pierre's supported loader", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({
            revisions: [
              {
                id: review.id,
                threadId: review.threadId,
                snapshot: review.snapshot,
                createdAt: review.createdAt,
                target: { type: "uncommitted" },
                fileCount: 1,
                annotationCount: 0,
                unresolvedCount: 0,
                viewedCount: 0,
              },
            ],
          }),
          reviewFileContents: async () => ({
            old: { path: "src/example.ts", content: "context\nold\ncontext\n" },
            new: { path: "src/example.ts", content: "context\nnew\ncontext\n" },
          }),
        } as any,
      },
    );

    const diff = await slot.findByTestId("pierre-diff");
    expect(diff.getAttribute("data-expand-unchanged")).toBe("false");
    expect(diff.getAttribute("data-hunk-separators")).toBe("line-info");
    slot.getByRole("button", { name: "Load context" }).click();
    await vi.waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "reviewFileContents",
        input: { reviewId: review.id, filePath: "src/example.ts" },
      });
    });
    slot.lifecycle.unmount();
  });

  it("opens accessible feedback, preserves drafts, and sends selected comments", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const root = {
      id: "22222222-2222-4222-8222-222222222221",
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "review this line",
      createdAt: 1,
      sentAt: null,
      resolvedAt: null,
      author: "human",
      parentId: null,
      fileLevel: false,
      carriedFromAnnotationId: null,
      resolutionSuggestion: null,
    };
    const review = { ...reviewFixture(), annotations: [root] } as any;
    const calls: any[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          sendBatch: async (input: any) => {
            calls.push(input);
            return { sentAt: 10 };
          },
        } as any,
      },
    );

    expect(slot.queryByRole("dialog")).toBeNull();
    const trigger = (
      await slot.findAllByRole("button", {
        name: "Review feedback, 1 pending/unsent comments",
      })
    )[0]!;
    trigger.click();
    const dialog = await slot.findByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(slot.getByRole("heading", { name: "Review feedback" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Reply" }));
    const reply = await within(dialog).findByLabelText(
      "Reply to src/example.ts:1 (new)",
    );
    fireEvent.change(reply, { target: { value: "draft reply" } });
    const note = slot.getByLabelText("Review note");
    fireEvent.change(note, { target: { value: "draft summary" } });
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await vi.waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.click();
    await slot.findByRole("dialog");
    expect(
      (slot.getByLabelText("Review note") as HTMLTextAreaElement).value,
    ).toBe("draft summary");
    expect(
      (
        slot.getByLabelText(
          "Reply to src/example.ts:1 (new)",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("draft reply");

    const checkbox = slot.getByLabelText("Select src/example.ts:1 (new)");
    fireEvent.click(checkbox);
    slot.getByRole("button", { name: "Send 1 comment to agent" }).click();
    await vi.waitFor(() => {
      expect(calls).toEqual([
        { reviewId: review.id, annotationIds: [root.id] },
      ]);
    });
    slot.lifecycle.unmount();
  });

  it("replies inline to an agent root and sends the human reply", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const root = {
      id: "66666666-6666-4666-8666-666666666661",
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "agent finding",
      createdAt: 1,
      sentAt: null,
      resolvedAt: null,
      author: "agent",
      parentId: null,
      fileLevel: false,
      carriedFromAnnotationId: null,
      resolutionSuggestion: null,
    };
    const humanReply = {
      ...root,
      id: "66666666-6666-4666-8666-666666666662",
      body: "human response",
      author: "human",
      parentId: root.id,
    };
    const review = { ...reviewFixture(), annotations: [root] } as any;
    const addCalls: any[] = [];
    const sendCalls: any[] = [];
    let addAttempt = 0;
    let rejectFirstAttempt: ((cause: Error) => void) | undefined;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          addAnnotation: (input: any) => {
            addCalls.push(input);
            addAttempt += 1;
            if (addAttempt === 1)
              return new Promise((_resolve, reject) => {
                rejectFirstAttempt = reject;
              });
            return Promise.resolve({ annotation: humanReply });
          },
          sendBatch: async (input: any) => {
            sendCalls.push(input);
            return { sentAt: 20 };
          },
        } as any,
      },
    );

    const replyButton = await slot.findByRole("button", {
      name: "Reply to AI comment at src/example.ts:1 (new)",
    });
    fireEvent.click(replyButton);
    let textarea = await slot.findByLabelText(
      "Reply to src/example.ts:1 (new)",
    );
    fireEvent.change(textarea, { target: { value: "discard this draft" } });
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(slot.queryByLabelText("Reply to src/example.ts:1 (new)")).toBeNull();

    fireEvent.click(
      slot.getByRole("button", {
        name: "Reply to AI comment at src/example.ts:1 (new)",
      }),
    );
    textarea = await slot.findByLabelText("Reply to src/example.ts:1 (new)");
    fireEvent.change(textarea, { target: { value: "human response" } });
    const submitReply = slot.getByRole("button", { name: "Reply" });
    fireEvent.pointerDown(submitReply);
    fireEvent.pointerUp(submitReply);
    expect(slot.queryByText(/Comment on src\/example\.ts:1/)).toBeNull();
    fireEvent.click(submitReply);
    fireEvent.click(submitReply);
    await vi.waitFor(() => expect(addCalls).toHaveLength(1));
    expect((submitReply as HTMLButtonElement).disabled).toBe(true);
    rejectFirstAttempt?.(new Error("temporary reply failure"));
    await slot.findByText("temporary reply failure");
    expect((textarea as HTMLTextAreaElement).value).toBe("human response");
    fireEvent.click(slot.getByRole("button", { name: "Reply" }));

    await vi.waitFor(() => {
      expect(addCalls).toHaveLength(2);
      expect(addCalls[1]).toMatchObject({
        reviewId: review.id,
        filePath: "src/example.ts",
        side: "new",
        startLine: 1,
        endLine: 1,
        body: "human response",
        parentId: root.id,
      });
    });
    fireEvent.click(
      (
        await slot.findAllByRole("button", {
          name: "Review feedback, 1 pending/unsent comments",
        })
      )[1]!,
    );
    const dialog = await slot.findByRole("dialog");
    expect(
      (
        within(dialog).getByLabelText(
          "Select src/example.ts:1 (new)",
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(dialog).getByLabelText(
          "Select reply to src/example.ts:1 (new)",
        ) as HTMLInputElement
      ).disabled,
    ).toBe(false);
    fireEvent.click(
      within(dialog).getByLabelText("Select reply to src/example.ts:1 (new)"),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send 1 comment to agent" }),
    );
    await vi.waitFor(() => {
      expect(sendCalls).toEqual([
        { reviewId: review.id, annotationIds: [humanReply.id] },
      ]);
    });
    slot.lifecycle.unmount();
  });

  it("replies to an AI reply by targeting its existing root", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const root = {
      id: "77777777-7777-4777-8777-777777777771",
      filePath: "src/example.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "human root",
      createdAt: 1,
      sentAt: null,
      resolvedAt: null,
      author: "human",
      parentId: null,
      fileLevel: false,
      carriedFromAnnotationId: null,
      resolutionSuggestion: null,
    };
    const agentReply = {
      ...root,
      id: "77777777-7777-4777-8777-777777777772",
      body: "agent reply",
      author: "agent",
      parentId: root.id,
    };
    const humanReply = {
      ...root,
      id: "77777777-7777-4777-8777-777777777773",
      body: "human follow-up",
      parentId: root.id,
    };
    const review = {
      ...reviewFixture(),
      annotations: [root, agentReply],
    } as any;
    let submitted: any;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          addAnnotation: async (input: any) => {
            submitted = input;
            return { annotation: humanReply };
          },
        } as any,
      },
    );

    fireEvent.click(
      await slot.findByRole("button", {
        name: "Reply to AI comment at src/example.ts:1 (new)",
      }),
    );
    const textarea = await slot.findByLabelText(
      "Reply to src/example.ts:1 (new)",
    );
    fireEvent.change(textarea, { target: { value: "human follow-up" } });
    fireEvent.click(slot.getByRole("button", { name: "Reply" }));
    await vi.waitFor(() => expect(submitted).toBeTruthy());
    expect(submitted).toMatchObject({
      parentId: root.id,
      body: "human follow-up",
    });
    expect(submitted.parentId).not.toBe(agentReply.id);
    await slot.findByText("human follow-up");
    slot.lifecycle.unmount();
  });

  it("keeps file-level replies on the existing whole-file comment path", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const root = {
      id: "88888888-8888-4888-8888-888888888881",
      filePath: "src/example.ts",
      side: "new",
      startLine: 0,
      endLine: 0,
      body: "whole-file agent note",
      createdAt: 1,
      sentAt: null,
      resolvedAt: null,
      author: "agent",
      parentId: null,
      fileLevel: true,
      carriedFromAnnotationId: null,
      resolutionSuggestion: null,
    };
    const humanReply = {
      ...root,
      id: "88888888-8888-4888-8888-888888888882",
      body: "whole-file response",
      author: "human",
      parentId: root.id,
    };
    const review = { ...reviewFixture(), annotations: [root] } as any;
    let submitted: any;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          addAnnotation: async (input: any) => {
            submitted = input;
            return { annotation: humanReply };
          },
        } as any,
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Reply" }));
    const textarea = await slot.findByLabelText(
      "Reply to src/example.ts (whole file)",
    );
    fireEvent.change(textarea, { target: { value: "whole-file response" } });
    fireEvent.click(slot.getByRole("button", { name: "Reply" }));
    await vi.waitFor(() => expect(submitted).toBeTruthy());
    expect(submitted).toMatchObject({
      filePath: "src/example.ts",
      startLine: 0,
      endLine: 0,
      parentId: root.id,
    });
    slot.lifecycle.unmount();
  });

  it("shows the empty state after viewing the last unviewed file", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = {
      ...reviewFixture(),
      files: [
        ...reviewFixture().files,
        {
          ...reviewFixture().files[0],
          path: "docs/guide.md",
          patch: patch.replaceAll("src/example.ts", "docs/guide.md"),
        },
      ],
      viewedPaths: ["docs/guide.md"],
    } as any;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          markFileViewed: async () => ({ viewedCount: 2 }),
        } as any,
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Unviewed" }));
    const fileSelect = await slot.findByLabelText("Changed file", {
      exact: true,
    });
    expect((fileSelect as HTMLSelectElement).value).toBe("src/example.ts");
    slot.getByRole("button", { name: "Viewed & next" }).click();
    await vi.waitFor(() => {
      expect((fileSelect as HTMLSelectElement).value).toBe("");
      expect((fileSelect as HTMLSelectElement).disabled).toBe(true);
    });
    expect(slot.getByText("No changed files.")).toBeTruthy();
    expect(slot.queryByRole("dialog")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("filters mobile files and preserves an empty selection when no files match", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = {
      ...reviewFixture(),
      files: [
        ...reviewFixture().files,
        {
          ...reviewFixture().files[0],
          path: "docs/guide.md",
          patch: patch.replaceAll("src/example.ts", "docs/guide.md"),
        },
      ],
      annotations: [
        {
          id: "22222222-2222-4222-8222-222222222221",
          filePath: "src/example.ts",
          side: "new",
          startLine: 1,
          endLine: 1,
          body: "inline root",
          createdAt: 1,
          sentAt: null,
          resolvedAt: null,
          author: "human",
          parentId: null,
          fileLevel: false,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          filePath: "src/example.ts",
          side: "new",
          startLine: 1,
          endLine: 1,
          body: "reply",
          createdAt: 2,
          sentAt: null,
          resolvedAt: null,
          author: "human",
          parentId: "22222222-2222-4222-8222-222222222221",
          fileLevel: false,
        },
        {
          id: "22222222-2222-4222-8222-222222222223",
          filePath: "docs/guide.md",
          side: "new",
          startLine: 0,
          endLine: 0,
          body: "file root",
          createdAt: 3,
          sentAt: null,
          resolvedAt: null,
          author: "human",
          parentId: null,
          fileLevel: true,
        },
      ],
    } as any;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
        } as any,
      },
    );

    const fileSelect = await slot.findByLabelText("Changed file", {
      exact: true,
    });
    fireEvent.change(slot.getByLabelText("Changed file filter"), {
      target: { value: "with-open-comments" },
    });
    await vi.waitFor(() => {
      expect(
        Array.from((fileSelect as HTMLSelectElement).options).map(
          (option) => option.value,
        ),
      ).toEqual(["src/example.ts", "docs/guide.md"]);
    });
    expect(slot.getAllByLabelText("1 open comment threads")).toHaveLength(2);

    fireEvent.change(slot.getByLabelText("Search files on mobile"), {
      target: { value: "not-present" },
    });
    await vi.waitFor(() => {
      expect((fileSelect as HTMLSelectElement).value).toBe("");
      expect((fileSelect as HTMLSelectElement).disabled).toBe(true);
    });
    expect(slot.getByText("No changed files.")).toBeTruthy();

    fireEvent.change(slot.getByLabelText("Search files on mobile"), {
      target: { value: "src" },
    });
    await vi.waitFor(() => {
      expect(
        Array.from((fileSelect as HTMLSelectElement).options).map(
          (option) => option.value,
        ),
      ).toEqual(["src/example.ts"]);
    });
    slot.getByRole("button", { name: "Viewed & next" }).click();
    await vi.waitFor(() => {
      expect((fileSelect as HTMLSelectElement).value).toBe("src/example.ts");
    });
    expect(
      Array.from((fileSelect as HTMLSelectElement).options).map(
        (option) => option.value,
      ),
    ).not.toContain("docs/guide.md");
    slot.lifecycle.unmount();
  });

  it("adds and shows a file-level comment", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const added = {
      id: "33333333-3333-4333-8333-333333333331",
      filePath: "src/example.ts",
      side: "new",
      startLine: 0,
      endLine: 0,
      body: "file note text",
      createdAt: 1,
      sentAt: null,
      resolvedAt: null,
      author: "human",
      parentId: null,
      fileLevel: true,
      carriedFromAnnotationId: null,
      resolutionSuggestion: null,
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          addAnnotation: async () => ({ annotation: added }),
        } as any,
      },
    );

    const open = await slot.findByRole("button", { name: "Comment on file" });
    open.click();
    const textarea = await slot.findByLabelText("File comment");
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea, "file note text");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    slot.getByRole("button", { name: "Add comment" }).click();
    await vi.waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "addAnnotation",
        input: {
          reviewId: review.id,
          filePath: "src/example.ts",
          body: "file note text",
          fileLevel: true,
        },
      });
    });
    slot.lifecycle.unmount();
  });
});
describe("comment list behavior", () => {
  it("collapses resolved comments and marks agent comments unsendable", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = {
      ...reviewFixture(),
      annotations: [
        {
          id: "22222222-2222-4222-8222-222222222221",
          filePath: "src/example.ts",
          side: "new",
          startLine: 1,
          endLine: 1,
          body: "resolved human comment",
          createdAt: 1,
          sentAt: null,
          resolvedAt: 2,
          author: "human",
          carriedFromAnnotationId: null,
          resolutionSuggestion: null,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          filePath: "src/example.ts",
          side: "new",
          startLine: 2,
          endLine: 2,
          body: "agent observation",
          createdAt: 3,
          sentAt: null,
          resolvedAt: null,
          author: "agent",
          carriedFromAnnotationId: null,
          resolutionSuggestion: null,
        },
      ],
    } as any;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({
            revisions: [
              {
                id: review.id,
                threadId: review.threadId,
                snapshot: review.snapshot,
                createdAt: review.createdAt,
                target: { type: "uncommitted" },
                fileCount: 1,
                annotationCount: 2,
                unresolvedCount: 1,
                viewedCount: 0,
              },
            ],
          }),
        } as any,
      },
    );

    // Resolved comment renders collapsed: no checkbox until expanded.
    const feedbackTrigger = (
      await slot.findAllByRole("button", {
        name: "Review feedback, 0 pending/unsent comments",
      })
    )[0]!;
    fireEvent.click(feedbackTrigger);
    const dialog = await slot.findByRole("dialog");
    await within(dialog).findByRole("button", {
      name: "Show src/example.ts:1 (new)",
    });
    expect(
      within(dialog).queryByRole("checkbox", {
        name: "Select src/example.ts:1 (new)",
      }),
    ).toBeNull();
    within(dialog)
      .getByRole("button", { name: "Show src/example.ts:1 (new)" })
      .click();
    const resolvedBox = (await vi.waitFor(() => {
      const box = dialog.querySelector(
        'input[aria-label="Select src/example.ts:1 (new)"]',
      ) as HTMLInputElement | null;
      expect(box).not.toBeNull();
      return box;
    })) as HTMLInputElement;
    expect(resolvedBox.disabled).toBe(true);

    // Agent comment shows the agent chip and cannot be selected for a batch.
    expect(within(dialog).getByText("AI comment")).toBeTruthy();
    const agentBox = dialog.querySelector(
      'input[aria-label="Select src/example.ts:2 (new)"]',
    ) as HTMLInputElement;
    expect(agentBox.disabled).toBe(true);

    // Only the agent comment is unresolved, but agent comments are never
    // pending, so nothing is counted or selectable to send.
    expect(within(dialog).queryByText(/1 pending comment/)).toBeNull();
    slot.lifecycle.unmount();
  });
});

let app0: any = null;

const entityChange = {
  entityId: "src/example.ts::function::alpha",
  changeType: "modified",
  entityType: "function",
  entityName: "alpha",
  startLine: 5,
  endLine: 6,
  oldStartLine: 5,
  oldEndLine: 6,
  filePath: "src/example.ts",
  structuralChange: false,
} as any;

describe("comment locate flow", () => {
  function locateFixture() {
    const review = reviewFixture();
    return {
      ...review,
      files: [
        ...review.files,
        {
          ...review.files[0],
          path: "src/other.ts",
          patch: patch.replaceAll("src/example.ts", "src/other.ts"),
        },
      ],
      viewedPaths: ["src/example.ts"],
      annotations: [
        {
          id: "55555555-5555-4555-8555-555555555551",
          filePath: "src/example.ts",
          side: "new",
          startLine: 1,
          endLine: 1,
          body: "locate me",
          createdAt: 1,
          sentAt: null,
          resolvedAt: null,
          author: "human",
          parentId: null,
          fileLevel: false,
          carriedFromAnnotationId: null,
          resolutionSuggestion: null,
        },
      ],
    } as any;
  }

  it("locates filtered comments from the feedback drawer and restores the diff", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review: locateFixture() }),
          revisions: async () => ({
            revisions: [
              {
                id: "latest-review",
                threadId: "thread-ui",
                snapshot: "latest-snapshot",
                createdAt: 2,
                target: { type: "uncommitted" },
                fileCount: 2,
                annotationCount: 1,
                unresolvedCount: 1,
                viewedCount: 0,
              },
              {
                id: locateFixture().id,
                threadId: "thread-ui",
                snapshot: locateFixture().snapshot,
                createdAt: 1,
                target: { type: "uncommitted" },
                fileCount: 2,
                annotationCount: 1,
                unresolvedCount: 1,
                viewedCount: 0,
              },
            ],
          }),
          entitySummary: async () => ({
            status: "unavailable",
            reason: "test fixture",
          }),
        } as any,
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    await slot.findByRole("status", { name: "Stale review revision" });
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.change(slot.getByLabelText("Changed file filter"), {
      target: { value: "unviewed" },
    });
    fireEvent.change(slot.getByLabelText("Search files on mobile"), {
      target: { value: "other" },
    });
    const fileSelect = slot.getByLabelText("Changed file", { exact: true });
    await vi.waitFor(() => {
      expect((fileSelect as HTMLSelectElement).value).toBe("src/other.ts");
    });
    fireEvent.click(
      slot.getByRole("button", { name: "Entities view (experimental)" }),
    );
    fireEvent.click(
      (
        await slot.findAllByRole("button", {
          name: "Review feedback, 1 pending/unsent comments",
        })
      )[1]!,
    );
    const dialog = await slot.findByRole("dialog");
    const locateButton = await within(dialog).findByRole("button", {
      name: "Show src/example.ts:1 (new) in diff",
    });
    fireEvent.click(locateButton);
    await vi.waitFor(() => {
      expect(slot.queryByRole("dialog")).toBeNull();
      expect((fileSelect as HTMLSelectElement).value).toBe("src/example.ts");
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
    expect(
      (slot.getByLabelText("Search files on mobile") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (slot.getByLabelText("Changed file filter") as HTMLSelectElement).value,
    ).toBe("all");
    expect(
      slot.getByRole("button", { name: "Diff", pressed: true }),
    ).toBeTruthy();
    expect(
      slot.getByRole("status", { name: "Stale review revision" }),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("keeps polling when the diff card renders late (file switch)", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review: locateFixture() }),
          revisions: async () => ({ revisions: [] }),
        } as any,
      },
    );
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    fireEvent.click(
      (
        await slot.findAllByRole("button", {
          name: "Review feedback, 1 pending/unsent comments",
        })
      )[0]!,
    );
    await slot.findByRole("dialog");
    const locateButton = await slot.findByRole("button", {
      name: "Show src/example.ts:1 (new) in diff",
    });
    // Simulate Pierre's late render: the annotation card appears only after
    // the first poll intervals would have passed (the old 3-attempt fix
    // failed here because it stopped at 180ms).
    const marker = document.createElement("div");
    marker.setAttribute(
      "data-annotation-id",
      "55555555-5555-4555-8555-555555555551",
    );
    marker.scrollIntoView = scrollIntoView;
    setTimeout(() => {
      document.body.appendChild(marker);
    }, 400);
    locateButton.click();
    await vi.waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });
    slot.lifecycle.unmount();
  });
});

describe("entity summary flow (semantic entry)", () => {
  it("renders the summary on toggle and hides cosmetics by default", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const summaryCalls: any[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async (input: any) => {
            summaryCalls.push(input);
            return {
              status: "ok",
              reason: null,
              changes: [
                {
                  entityId: "a::function::mod",
                  changeType: "modified",
                  entityType: "function",
                  entityName: "mod",
                  filePath: "src/example.ts",
                  startLine: 5,
                  endLine: 6,
                  structuralChange: null,
                },
                {
                  entityId: "a::function::cosmetic",
                  changeType: "modified",
                  entityType: "function",
                  entityName: "cosmeticOnlyRefactor",
                  filePath: "src/example.ts",
                  startLine: 40,
                  endLine: 42,
                  structuralChange: false,
                },
                {
                  entityId: "a::function::gone",
                  changeType: "deleted",
                  entityType: "function",
                  entityName: "gone",
                  filePath: "src/example.ts",
                  startLine: null,
                  endLine: null,
                  structuralChange: null,
                },
              ],
            };
          },
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    await vi.waitFor(() => {
      expect(summaryCalls).toContainEqual({ reviewId: review.id });
      // priority order: deleted first, then modified (nav + explorer both render)
      expect(slot.getAllByText("deleted").length).toBeGreaterThanOrEqual(1);
      expect(slot.getAllByText(/gone/).length).toBeGreaterThanOrEqual(1);
      expect(slot.getAllByText("modified").length).toBeGreaterThanOrEqual(1);
    });
    // cosmetics hidden by default
    expect(slot.queryByText(/cosmeticOnlyRefactor/)).toBeNull();
    slot.getByLabelText("Hide cosmetics and module-level changes").click();
    expect(
      slot.getAllByText(/cosmeticOnlyRefactor/).length,
    ).toBeGreaterThanOrEqual(1);
    slot.lifecycle.unmount();
  });

  it("jumps to the diff when a summary row is located", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async () => ({
            status: "ok",
            reason: null,
            changes: [
              {
                entityId: "a::function::mod",
                changeType: "modified",
                entityType: "function",
                entityName: "mod",
                filePath: "src/example.ts",
                startLine: 5,
                endLine: 6,
                structuralChange: null,
              },
            ],
          }),
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    await vi.waitFor(() => {
      expect(slot.getAllByText("modified").length).toBeGreaterThanOrEqual(1);
    });
    slot.getByRole("button", { name: "Go to mod" }).click();
    // jump only switches file/pends the anchor; no error surfaced
    expect(slot.queryByText(/sem is unavailable/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("groups entities by file and renders per-entity content diffs", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = {
      ...reviewFixture(),
      files: [
        reviewFixture().files[0],
        {
          path: "src/other.ts",
          previousPath: null,
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: `diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,2 +1,3 @@
 first
+second
 third
`,
          truncated: false,
        },
      ],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async () => ({
            status: "ok",
            reason: null,
            changes: [
              {
                entityId: "src/example.ts::function::alpha",
                changeType: "modified",
                entityType: "function",
                entityName: "alpha",
                filePath: "src/example.ts",
                startLine: 5,
                endLine: 6,
                structuralChange: true,
                beforeContent: "function alpha() {\n  return 1;\n}",
                afterContent: "function alpha() {\n  return 42;\n}",
              },
              {
                entityId: "src/other.ts::function::beta",
                changeType: "added",
                entityType: "function",
                entityName: "beta",
                filePath: "src/other.ts",
                startLine: 2,
                endLine: 3,
                structuralChange: true,
                beforeContent: null,
                afterContent: "function beta() {\n  return 2;\n}",
              },
            ],
          }),
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    // grouped by file, one count chip per file section
    await vi.waitFor(() => {
      expect(slot.getAllByText(/entit(y|ies)$/)).toHaveLength(2);
    });
    // alpha expands into a Pierre-rendered content diff (FileDiff renders a
    // web component that jsdom cannot hydrate, so assert the surface exists
    // rather than the hunk text - patch synthesis is covered in the lib tests)
    slot.getAllByRole("button", { name: /modified alpha/ })[0]!.click();
    await vi.waitFor(() => {
      expect(slot.container.innerHTML).toContain('data-testid="pierre-diff"');
    });
    expect(slot.container.innerHTML).not.toContain("Entity too large");
    // beta is one-sided (added): also renders through the Pierre surface
    slot.getAllByText(/beta/)[0]!.click();
    await vi.waitFor(() => {
      expect(
        slot.container.innerHTML.split('data-testid="pierre-diff"').length - 1,
      ).toBeGreaterThanOrEqual(2);
    });
    slot.lifecycle.unmount();
  });

  it("expands a summary row and loads its transitive impact", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const impactCalls: any[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async () => ({
            status: "ok",
            reason: null,
            changes: [{ ...entityChange, structuralChange: true }],
          }),
          entityImpact: async (input: any) => {
            impactCalls.push(input);
            return {
              status: "ok",
              reason: null,
              dependents: [
                {
                  entityId: "src/other.ts::function::caller",
                  file: "src/other.ts",
                  lines: [12, 20],
                  name: "caller",
                  type: "function",
                },
              ],
              tests: [],
              total: 1,
              depth: 1,
            };
          },
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    await vi.waitFor(() => {
      expect(slot.getAllByText("modified").length).toBeGreaterThanOrEqual(1);
    });
    slot.getAllByText(/alpha/)[0]!.click();
    await vi.waitFor(() => {
      expect(impactCalls).toHaveLength(1);
    });
    // impact detail lists dependents once the rpc resolves
    await slot.findByText(/caller/);
    slot.lifecycle.unmount();
  });

  it("reports when a summarized entity cannot be located in the diff", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async () => ({
            status: "ok",
            reason: null,
            changes: [
              {
                ...entityChange,
                entityName: "faraway",
                startLine: 900,
                endLine: 910,
                structuralChange: true,
              },
            ],
          }),
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    await vi.waitFor(() => {
      expect(slot.getAllByText("modified").length).toBeGreaterThanOrEqual(1);
    });
    slot.getByRole("button", { name: "Go to faraway" }).click();
    await slot.findByText(/faraway has no visible lines in the diff/);
    slot.lifecycle.unmount();
  });

  it("shows the reason when the revision summary is unavailable", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          entitySummary: async () => ({
            status: "unavailable",
            reason: "sem binary not found",
            changes: [],
          }),
        } as any,
      },
    );

    await vi.waitFor(() => {
      slot.getByRole("button", { name: "Entities view (experimental)" });
    });
    slot.getByRole("button", { name: "Entities view (experimental)" }).click();
    await slot.findByText(/sem is unavailable: sem binary not found/);
    slot.lifecycle.unmount();
  });
});

describe("review target picker (specific commit)", () => {
  it("requires a sha and passes the commit target to refresh", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const review = reviewFixture();
    const refreshCalls: any[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "review/thread-ui" },
      {
        context: { projectId: "project-ui", threadId: "thread-ui" },
        rpc: {
          review: async () => ({ review }),
          revisions: async () => ({ revisions: [] }),
          refreshReview: async (input: any) => {
            refreshCalls.push(input);
            return {
              review: {
                ...review,
                id: "22222222-2222-4222-8222-222222222222",
                snapshot: "commit-ui",
              },
            };
          },
        } as any,
      },
    );

    const select = await slot.findByRole("combobox", {
      name: "Review target",
    });
    fireEvent.change(select, { target: { value: "commit" } });
    const reviewButton = slot.getByRole("button", { name: "Review commit" });
    // no sha yet -> the button must not silently fall back to uncommitted
    expect(reviewButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(slot.getByLabelText("Commit sha"), {
      target: { value: "846e364c9db491759b7f391cd1ebb622e943badc" },
    });
    expect(reviewButton.hasAttribute("disabled")).toBe(false);
    reviewButton.click();
    await vi.waitFor(() => {
      expect(refreshCalls).toContainEqual({
        threadId: "thread-ui",
        target: {
          type: "commit",
          sha: "846e364c9db491759b7f391cd1ebb622e943badc",
        },
      });
    });
    slot.lifecycle.unmount();
  });
});

describe("thread header action (compact viewport)", () => {
  it("renders an icon control that opens the full review panel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const headerAction = app.threadHeaderActions[0]!;
    const slot = renderSlot(headerAction, {
      threadId: "thread-ui",
      projectId: "project-ui",
      isCompactViewport: true,
    });

    const button = await slot.findByRole("button", {
      name: "Open Review Workspace",
    });
    button.click();
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "review",
      options: { subPath: "review/thread-ui" },
    });
    slot.lifecycle.unmount();
  });
});
