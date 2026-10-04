import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "/opt/mise/installs/node/24.21.0/lib/node_modules/playwright/index.mjs";
import {
  assertExactlyOneNewRequest,
  assertNoUnexpectedRequests,
  assertUniqueActiveSuggestion,
  attributedSeedPrompt,
  captureRequestIds,
  correlateAcceptedCompletion,
  newRequests,
} from "./live-guards.mjs";

const MODEL = "openai-codex/gpt-6-luna";
const SEED_TEXT = process.env.LAZY_CHAT_SEED_TEXT ?? "ACK Phase 0 final gate.";
const SEED_DIRECTIVE = "::lazy-reply{}";
const SEED_BODY = `Reply exactly with these two lines and no other text:\n${SEED_TEXT}\n${SEED_DIRECTIVE}\nDo not call tools or do any implementation work.`;
const INLINE_PROMPT =
  "Phase 0 inline send proof. Reply exactly ACK and use no tools.";
const threadId = process.env.LAZY_CHAT_FIXTURE_THREAD ?? "thr_gfv38msr82";
const evidenceDir = resolve(
  process.env.LAZY_CHAT_EVIDENCE_DIR ??
    "../../.agents/scratchpad/lazyai-bb-wireframes/execution/phase0-live",
);

function bbJson(args) {
  return JSON.parse(
    execFileSync("bb", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

function readThread() {
  const result = bbJson(["thread", "show", threadId, "--json"]);
  assert.equal(
    result.thread?.id,
    threadId,
    "bb returned a different thread identity",
  );
  const thread = result.thread;
  assert.ok(thread.title?.trim(), "fixture thread has no current title");
  assert.equal(
    thread.visibility,
    "visible",
    "fixture is not visible in navigation",
  );
  assert.equal(thread.archivedAt, null, "fixture is archived");
  assert.equal(thread.deletedAt, null, "fixture is deleted");
  assert.equal(
    thread.parentThreadId,
    null,
    "fixture must be a detached root thread before any preparation send",
  );
  return thread;
}

function readEvents() {
  return bbJson(["thread", "log", threadId, "--all", "--json"]);
}

function assertSameIdentity(before, after) {
  for (const key of [
    "id",
    "title",
    "projectId",
    "environmentId",
    "parentThreadId",
  ])
    assert.equal(
      after[key],
      before[key],
      `fixture ${key} changed during preparation`,
    );
}

function assertIdle(thread, stage) {
  assert.equal(thread.status, "idle", `fixture must be idle ${stage}`);
}

async function waitForDraftSync(
  page,
  { inlineExact, inlineIncludes = [], nativeIncludes = [] },
) {
  await page.waitForFunction(
    ({ inlineExact, inlineIncludes, nativeIncludes }) => {
      const inline = document.querySelector(
        'textarea[aria-label="Reply draft"]',
      )?.value;
      const native = document.querySelector(
        '[contenteditable="true"][role="textbox"]',
      )?.innerText;
      if (inline === undefined || native === undefined) return false;
      if (inlineExact !== undefined && inline !== inlineExact) return false;
      return (
        inlineIncludes.every((text) => inline.includes(text)) &&
        nativeIncludes.every((text) => native.includes(text))
      );
    },
    { inlineExact, inlineIncludes, nativeIncludes },
    { timeout: 8_000 },
  );
}

function exactNewRequest(baselineIds, events, expectedInitiator) {
  const request = assertExactlyOneNewRequest(
    baselineIds,
    events,
    expectedInitiator,
  );
  assert.equal(request.threadId, threadId);
  return request;
}

async function waitForNewRequest(
  baselineIds,
  expectedInitiator,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = readEvents();
    const requests = newRequests(baselineIds, events);
    if (requests.length > 1)
      exactNewRequest(baselineIds, events, expectedInitiator);
    if (requests.length === 1)
      return {
        request: exactNewRequest(baselineIds, events, expectedInitiator),
        events,
      };
    await new Promise((done) => setTimeout(done, 400));
  }
  throw new Error(`Timed out waiting for one new ${expectedInitiator} request`);
}

async function waitForCompletion(
  requestId,
  expectedInitiator,
  timeoutMs = 140_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const events = readEvents();
    try {
      return {
        events,
        ...correlateAcceptedCompletion(
          events,
          requestId,
          threadId,
          expectedInitiator,
        ),
      };
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(
    `Timed out waiting for request-correlated completion: ${lastError}`,
  );
}

function assertSeedResult(events, request, turnId, seedPrompt) {
  assert.equal(
    request.data.input.length,
    1,
    "seed request must contain only one text input",
  );
  assert.equal(request.data.input[0].type, "text");
  assert.equal(request.data.input[0].text, seedPrompt, "seed prompt changed");
  assert.equal(request.data.execution.model, MODEL);
  assert.equal(request.data.execution.serviceTier, "default");
  assert.equal(request.data.execution.reasoningLevel, "low");
  const turnEvents = events.filter(
    (event) => event.scope?.kind === "turn" && event.scope.turnId === turnId,
  );
  assert.ok(
    !turnEvents.some((event) => event.data?.item?.type === "toolCall"),
    "bounded seed invoked a tool; stop without continuing to inline acceptance",
  );
  const completedItems = turnEvents.filter(
    (event) =>
      event.type === "item/completed" &&
      event.data?.item?.type === "agentMessage",
  );
  const rootMessages = completedItems.filter(
    (event) => event.data.item.parentToolCallId === undefined,
  );
  assert.equal(
    rootMessages.length,
    1,
    "seed turn did not produce one root assistant contribution",
  );
  assert.equal(
    rootMessages[0].data.item.text.trim(),
    `${SEED_TEXT}\n${SEED_DIRECTIVE}`,
    "latest seed contribution did not contain the exact seed and directive",
  );
  const latestSuccessfulCompletion = events
    .filter(
      (event) =>
        event.type === "turn/completed" &&
        event.data?.status === "completed" &&
        event.scope?.kind === "turn",
    )
    .at(-1);
  assert.equal(
    latestSuccessfulCompletion?.scope?.turnId,
    turnId,
    "seed is not the latest successful completed turn",
  );
  return rootMessages[0].data.item;
}

async function prepareFixture(thread, state, seedPrompt) {
  assertIdle(thread, "before its one explicit seed");
  const originalEvents = readEvents();
  const originalRequestIds = captureRequestIds(originalEvents);
  state.seedBaselineIds = originalRequestIds;
  const latestUserRequest = originalEvents
    .filter(
      (event) =>
        event.type === "client/turn/requested" &&
        event.data?.initiator === "user" &&
        event.data?.direction === "outbound",
    )
    .at(-1);
  const permissionMode = latestUserRequest?.data?.execution?.permissionMode;
  assert.ok(
    permissionMode,
    "cannot preserve fixture permission mode: no prior user request",
  );

  const immediatelyBeforeSeed = readEvents();
  assertNoUnexpectedRequests(originalRequestIds, immediatelyBeforeSeed);
  const threadBeforeSeed = readThread();
  assertSameIdentity(thread, threadBeforeSeed);
  assertIdle(threadBeforeSeed, "immediately before its one explicit seed");
  state.seedDispatchAttempted = true;
  execFileSync(
    "bb",
    [
      "thread",
      "tell",
      threadId,
      "--message-file",
      "-",
      "--json",
      "--mode",
      "steer",
      "--model",
      MODEL,
      "--service-tier",
      "default",
      "--reasoning-level",
      "low",
      "--permission-mode",
      permissionMode,
    ],
    { input: SEED_BODY, encoding: "utf8", timeout: 30_000 },
  );
  const { request } = await waitForNewRequest(originalRequestIds, "agent");
  state.seedRequestId = request.data.requestId;
  const completion = await waitForCompletion(request.data.requestId, "agent");
  const seedRequest = completion.request;
  assert.equal(seedRequest.data.input[0].text, seedPrompt);
  assert.equal(seedRequest.data.execution.model, MODEL);
  assert.equal(seedRequest.data.execution.serviceTier, "default");
  assert.equal(seedRequest.data.execution.reasoningLevel, "low");
  assert.equal(seedRequest.data.execution.permissionMode, permissionMode);
  const contribution = assertSeedResult(
    completion.events,
    seedRequest,
    completion.turnId,
    seedPrompt,
  );
  const after = readThread();
  assertSameIdentity(thread, after);
  assertIdle(after, "after the one seed");
  const allFinalEvents = readEvents();
  exactNewRequest(originalRequestIds, allFinalEvents, "agent");
  return {
    thread: after,
    seedRequest,
    seedContribution: contribution,
    inlineBaselineEvents: allFinalEvents,
    inlineBaselineIds: captureRequestIds(allFinalEvents),
  };
}

async function runLiveProof(state, prepared) {
  const thread = prepared.thread;
  const inlineBaselineIds = prepared.inlineBaselineIds;
  const priorExecution = prepared.seedRequest.data.execution;
  const browser = await chromium.launch({ headless: true });
  state.stage = "browser-navigation";
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const page = await context.newPage();
      const browserErrors = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      await page.goto("http://127.0.0.1:3000/", {
        waitUntil: "domcontentloaded",
      });
      const fixtureLink = page.getByRole("link").filter({
        has: page.getByText(thread.title, { exact: true }),
      });
      await fixtureLink.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(
        await fixtureLink.count(),
        1,
        `expected one visible link with the exact current fixture title ${JSON.stringify(thread.title)}`,
      );
      await fixtureLink.click();
      await page.waitForURL(
        (url) => url.pathname.split("/").includes(threadId),
        { timeout: 20_000 },
      );
      const route = new URL(page.url());
      assert.equal(
        route.pathname.split("/").filter((segment) => segment === threadId)
          .length,
        1,
        "navigation did not resolve to the exact fixture thread route",
      );
      const threadCard = page.locator(`[data-thread-id="${threadId}"]`).last();
      await threadCard.waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(await threadCard.getAttribute("data-thread-id"), threadId);
      const seed = SEED_TEXT;
      await page.getByText(seed, { exact: true }).last().waitFor({
        state: "visible",
        timeout: 20_000,
      });
      const editor = page.getByRole("textbox", {
        name: "Reply draft",
        exact: true,
      });
      await editor.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(
        await page
          .locator("[data-thread-id]")
          .last()
          .getAttribute("data-thread-id"),
        threadId,
      );

      state.stage = "composer-setup";
      await page
        .getByText(seed, { exact: true })
        .last()
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
        });
      const addSelectionToChat = page
        .getByRole("dialog")
        .getByRole("button", { name: "Add to chat", exact: true });
      await addSelectionToChat.waitFor({ state: "visible" });
      assert.equal(
        await addSelectionToChat.count(),
        1,
        "selection menu must expose exactly one Add to chat action",
      );
      await addSelectionToChat.click();
      const native = page.locator('[contenteditable="true"][role="textbox"]');
      const quoted = `> ${seed}\n`;
      await waitForDraftSync(page, {
        inlineExact: quoted,
        nativeIncludes: [seed],
      });
      assert.equal(
        await editor.inputValue(),
        quoted,
        "BB selection quote did not reach inline editor as the exact selected text",
      );

      await native.press("End");
      const mentionPath = "plugins/lazy-chat/package.json";
      const mentionTitle = `Workspace: ${mentionPath}`;
      await native.pressSequentially(` @${mentionPath}`);
      const typeahead = page.locator("[data-promptbox-typeahead-menu]");
      await typeahead.waitFor({ state: "visible" });
      const matchingSuggestions = typeahead.locator(
        `button[title=${JSON.stringify(mentionTitle)}]`,
      );
      await matchingSuggestions.first().waitFor({ state: "visible" });
      assert.equal(
        await matchingSuggestions.count(),
        1,
        `expected one exact native mention result titled ${JSON.stringify(mentionTitle)}`,
      );
      await native.press("ArrowDown");
      const suggestionRows = await typeahead
        .locator("button")
        .evaluateAll((buttons) =>
          buttons.map((button) => ({
            title: button.getAttribute("title"),
            active: button.classList.contains("bg-state-active"),
          })),
        );
      assertUniqueActiveSuggestion(suggestionRows, mentionTitle);
      // Never press Enter unless the exact target is the unique active row.
      await native.press("Enter");
      const mentionPill = native.locator('[data-prompt-mention="true"]');
      await waitForDraftSync(page, {
        inlineIncludes: [`@${mentionPath}`],
      });
      await mentionPill.waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(await mentionPill.count(), 1);
      assert.ok((await mentionPill.innerText()).includes(mentionPath));
      assert.ok(
        (await editor.inputValue()).includes(`@${mentionPath}`),
        "native structured mention did not reach inline draft",
      );
      const mentionEdited = `${await editor.inputValue()} mention text edit`;
      await editor.fill(mentionEdited);
      await waitForDraftSync(page, {
        inlineExact: mentionEdited,
        nativeIncludes: ["mention text edit"],
      });
      assert.equal(
        await mentionPill.count(),
        1,
        "inline edit removed native mention pill",
      );

      const attachmentInput = page
        .locator('[data-promptbox] input[type="file"]')
        .first();
      await attachmentInput.setInputFiles(
        resolve(import.meta.dirname, "README.md"),
      );
      const removeAttachment = page.getByRole("button", {
        name: "Remove README.md",
        exact: true,
      });
      await removeAttachment.waitFor({ state: "visible" });
      const draft = `${await editor.inputValue()}\n${INLINE_PROMPT}`;
      await editor.fill(draft);
      await waitForDraftSync(page, {
        inlineExact: draft,
        nativeIncludes: [INLINE_PROMPT],
      });
      assert.ok(
        await removeAttachment.isVisible(),
        "text edits removed the native composer attachment",
      );
      assert.ok(
        (await native.innerText()).includes(seed),
        "native composer missed inline quote",
      );
      assert.ok(
        (await native.innerText()).includes(INLINE_PROMPT),
        "inline edit missed native composer",
      );
      await native.press("End");
      await native.pressSequentially(" Native composer edit.");
      await waitForDraftSync(page, {
        inlineIncludes: ["Native composer edit."],
        nativeIncludes: ["Native composer edit."],
      });
      const exactText = `${await editor.inputValue()}\nFinal inline edit.`;
      await editor.fill(exactText);
      await waitForDraftSync(page, {
        inlineExact: exactText,
        nativeIncludes: ["Final inline edit."],
      });
      assert.equal(
        await mentionPill.count(),
        1,
        "later inline edits removed the mention pill",
      );
      assert.ok(
        await removeAttachment.isVisible(),
        "later text edits removed the attachment",
      );
      const nativeText = await native.innerText();
      for (const fragment of [seed, INLINE_PROMPT, "Native composer edit."])
        assert.ok(
          nativeText.includes(fragment),
          `final inline revision omitted ${fragment}`,
        );
      await editor.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve(evidenceDir, "live-shared-draft.png"),
        animations: "disabled",
      });

      state.stage = "pre-send-guard";
      const beforeIntentionalSend = readThread();
      assertSameIdentity(thread, beforeIntentionalSend);
      assertIdle(
        beforeIntentionalSend,
        "immediately before the intentional inline send",
      );
      await waitForDraftSync(page, {
        inlineExact: exactText,
        nativeIncludes: ["Final inline edit."],
      });
      const beforeSendEvents = readEvents();
      assertNoUnexpectedRequests(inlineBaselineIds, beforeSendEvents);
      assert.equal(
        await mentionPill.count(),
        1,
        "text edits removed the structured mention",
      );
      assert.ok(
        await removeAttachment.isVisible(),
        "text edits removed the attached test file",
      );
      state.stage = "intentional-inline-send";
      state.inlineSendClicked = true;
      await page
        .getByRole("button", { name: "Send reply", exact: true })
        .click();
      const { request: sent } = await waitForNewRequest(
        inlineBaselineIds,
        "user",
      );
      state.inlineRequestId = sent.data.requestId;
      assert.equal(
        sent.data.input[0].text,
        exactText,
        "BB accepted different inline text",
      );
      assert.deepEqual(sent.data.input[0].mentions, [
        {
          start: sent.data.input[0].text.indexOf(`@${mentionPath}`),
          end:
            sent.data.input[0].text.indexOf(`@${mentionPath}`) +
            `@${mentionPath}`.length,
          resource: {
            kind: "path",
            source: "workspace",
            entryKind: "file",
            path: mentionPath,
            label: "package.json",
          },
        },
      ]);
      assert.equal(sent.data.input[1].type, "localFile");
      assert.equal(sent.data.input[1].name, "README.md");
      assert.equal(sent.data.execution.model, priorExecution.model);
      assert.equal(sent.data.execution.serviceTier, priorExecution.serviceTier);
      assert.equal(
        sent.data.execution.reasoningLevel,
        priorExecution.reasoningLevel,
      );
      assert.equal(
        sent.data.execution.permissionMode,
        priorExecution.permissionMode,
      );

      state.stage = "request-correlated-completion";
      execFileSync(
        "bb",
        ["thread", "wait", threadId, "--timeout", "120s", "--json"],
        { encoding: "utf8", timeout: 130_000 },
      );
      const completion = await waitForCompletion(sent.data.requestId, "user");
      const turnItems = completion.events.filter(
        (event) =>
          event.scope?.kind === "turn" &&
          event.scope.turnId === completion.turnId &&
          event.type === "item/completed",
      );
      assert.deepEqual(
        turnItems.map((event) => event.data.item.type),
        ["agentMessage"],
      );
      assert.equal(turnItems[0].data.item.text, "ACK");

      state.stage = "reopen-verification";
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForURL((url) =>
        url.pathname.split("/").includes(threadId),
      );
      const reopenedMessage = page.getByText(/Final inline edit\./).last();
      await reopenedMessage.waitFor({ state: "visible", timeout: 30_000 });
      await reopenedMessage.scrollIntoViewIfNeeded();
      const acceptedMessage = reopenedMessage.locator(
        "xpath=ancestor::div[contains(@class, 'group/message')][1]",
      );
      await acceptedMessage
        .locator(
          '[data-prompt-mention-serialized-text="@plugins/lazy-chat/package.json"]',
        )
        .waitFor({ state: "visible" });
      assert.equal(sent.data.execution.model, MODEL);
      assert.equal(sent.data.execution.reasoningLevel, "low");
      assert.deepEqual(browserErrors, []);
      await page.screenshot({
        path: resolve(evidenceDir, "live-inline-submitted.png"),
        animations: "disabled",
      });
      state.stage = "complete";
      return {
        threadId,
        threadTitle: thread.title,
        threadRoute: route.pathname,
        seedRequestId: prepared.seedRequest.data.requestId,
        acceptedRequestId: sent.data.requestId,
        acceptedTurnId: completion.turnId,
        submittedText: exactText,
        execution: sent.data.execution,
        mention: sent.data.input[0].mentions[0],
        attachment: {
          type: sent.data.input[1].type,
          name: sent.data.input[1].name,
          sizeBytes: sent.data.input[1].sizeBytes,
        },
        response: turnItems[0].data.item.text,
        reopened: true,
        browserErrors,
        screenshots: ["live-shared-draft.png", "live-inline-submitted.png"],
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.size !== 2 || !args.has("--prepare") || !args.has("--send")) {
    throw new Error(
      "Live acceptance sends nothing by default. Explicitly opt into exactly one seed and one inline send with: pnpm run live-test -- --prepare --send",
    );
  }
  const seedPrompt = attributedSeedPrompt(process.env.BB_THREAD_ID, SEED_BODY);
  const state = {
    stage: "preflight",
    seedDispatchAttempted: false,
    seedRequestId: null,
    seedBaselineIds: null,
    seedRequestIdsObserved: [],
    inlineSendClicked: false,
    inlineRequestId: null,
    inlineBaselineIds: null,
    unexpectedRequestIds: [],
    observedRequestIdsAfterInlineBaseline: [],
    failureLogReadError: null,
  };
  let browserResult;
  try {
    await mkdir(evidenceDir, { recursive: true });
    const initialThread = readThread();
    assertIdle(initialThread, "before preparation");
    state.stage = "one-time-seed-preparation";
    const prepared = await prepareFixture(initialThread, state, seedPrompt);
    state.inlineBaselineIds = prepared.inlineBaselineIds;
    browserResult = await runLiveProof(state, prepared);
    await writeFile(
      resolve(evidenceDir, "live-test-result.json"),
      `${JSON.stringify({ status: "passed", ...browserResult }, null, 2)}\n`,
    );
    console.log(
      `PASS ${threadId}: explicitly prepared seed, exact active mention, one correlated native-pipeline inline request`,
    );
  } catch (cause) {
    state.unexpectedRequestIds = cause?.unexpectedRequestIds ?? [];
    if (!state.inlineBaselineIds && state.seedBaselineIds) {
      try {
        state.seedRequestIdsObserved = newRequests(
          state.seedBaselineIds,
          readEvents(),
        ).map((event) => event.data.requestId);
        if (!state.seedRequestId && state.seedRequestIdsObserved.length === 1)
          state.seedRequestId = state.seedRequestIdsObserved[0];
      } catch (inspectionError) {
        state.failureLogReadError =
          inspectionError instanceof Error
            ? inspectionError.message
            : String(inspectionError);
      }
    }
    if (state.inlineBaselineIds) {
      try {
        const observed = newRequests(state.inlineBaselineIds, readEvents()).map(
          (event) => event.data.requestId,
        );
        state.observedRequestIdsAfterInlineBaseline = observed;
        if (!state.inlineSendClicked)
          state.unexpectedRequestIds = [
            ...new Set([...state.unexpectedRequestIds, ...observed]),
          ];
      } catch (inspectionError) {
        state.failureLogReadError =
          inspectionError instanceof Error
            ? inspectionError.message
            : String(inspectionError);
      }
    }
    const error = cause instanceof Error ? cause.message : String(cause);
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      resolve(evidenceDir, "live-test-result.json"),
      `${JSON.stringify(
        {
          status: "failed",
          threadId,
          stage: state.stage,
          error,
          seedDispatchAttempted: state.seedDispatchAttempted,
          seedRequestId: state.seedRequestId,
          seedRequestIdsObserved: state.seedRequestIdsObserved,
          inlineSendClicked: state.inlineSendClicked,
          inlineRequestId: state.inlineRequestId,
          observedRequestIdsAfterInlineBaseline:
            state.observedRequestIdsAfterInlineBaseline,
          unexpectedRequestIds: state.unexpectedRequestIds,
          failureLogReadError: state.failureLogReadError,
        },
        null,
        2,
      )}\n`,
    );
    console.error(`FAIL ${state.stage}: ${error}`);
    throw cause;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
