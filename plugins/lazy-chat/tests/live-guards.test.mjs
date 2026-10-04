import { describe, expect, it } from "vitest";
import {
  assertExactlyOneNewRequest,
  assertNoUnexpectedRequests,
  assertUniqueActiveSuggestion,
  captureRequestIds,
  correlateAcceptedCompletion,
} from "../live-guards.mjs";

const threadId = "thread-1";
const userRequest = {
  type: "client/turn/requested",
  threadId,
  seq: 10,
  data: {
    direction: "outbound",
    initiator: "user",
    requestId: "request-user",
  },
};
const agentRequest = {
  ...userRequest,
  seq: 20,
  data: { ...userRequest.data, initiator: "agent", requestId: "request-agent" },
};
const userAccepted = {
  type: "turn/input/accepted",
  threadId,
  seq: 11,
  data: { clientRequestId: "request-user" },
  scope: { kind: "turn", turnId: "turn-user" },
};
const agentAccepted = {
  ...userAccepted,
  seq: 21,
  data: { clientRequestId: "request-agent" },
  scope: { kind: "turn", turnId: "turn-agent" },
};
const userCompleted = {
  type: "turn/completed",
  threadId,
  seq: 12,
  data: { status: "completed" },
  scope: { kind: "turn", turnId: "turn-user" },
};
const agentCompleted = {
  ...userCompleted,
  seq: 22,
  scope: { kind: "turn", turnId: "turn-agent" },
};

describe("live acceptance guards", () => {
  it("rejects an active mention highlight that is not the exact target title", () => {
    expect(() =>
      assertUniqueActiveSuggestion(
        [
          { title: "Workspace: other/package.json", active: true },
          { title: "Workspace: plugins/lazy-chat/package.json", active: false },
        ],
        "Workspace: plugins/lazy-chat/package.json",
      ),
    ).toThrow(/exactly one active suggestion/);
  });

  it("rejects any outbound request that appeared during setup", () => {
    const baseline = captureRequestIds([userRequest]);
    expect(() =>
      assertNoUnexpectedRequests(baseline, [userRequest, agentRequest]),
    ).toThrow(/setup-time request.*request-agent/);
  });

  it("does not accept an unrelated turn completion", () => {
    expect(() =>
      correlateAcceptedCompletion(
        [
          userRequest,
          userAccepted,
          { ...userCompleted, scope: { kind: "turn", turnId: "other-turn" } },
        ],
        "request-user",
        threadId,
        "user",
      ),
    ).toThrow(/completion for accepted turn turn-user/);
  });

  it("fails closed when the accepted request has no accepted-input mapping", () => {
    expect(() =>
      correlateAcceptedCompletion(
        [userRequest, userCompleted],
        "request-user",
        threadId,
        "user",
      ),
    ).toThrow(/accepted-input mapping/);
  });

  it("accepts the bounded agent seed only when agent origin is expected", () => {
    expect(
      correlateAcceptedCompletion(
        [agentRequest, agentAccepted, agentCompleted],
        "request-agent",
        threadId,
        "agent",
      ),
    ).toMatchObject({ accepted: agentAccepted, completed: agentCompleted });
    expect(() =>
      correlateAcceptedCompletion(
        [agentRequest, agentAccepted, agentCompleted],
        "request-agent",
        threadId,
        "user",
      ),
    ).toThrow(/unexpected initiator agent/);
  });

  it("keeps inline request correlation strict to user origin", () => {
    expect(
      correlateAcceptedCompletion(
        [userRequest, userAccepted, userCompleted],
        "request-user",
        threadId,
        "user",
      ),
    ).toMatchObject({ accepted: userAccepted, completed: userCompleted });
    expect(() =>
      correlateAcceptedCompletion(
        [userRequest, userAccepted, userCompleted],
        "request-user",
        threadId,
        "agent",
      ),
    ).toThrow(/unexpected initiator user/);
  });

  it("requires exactly one new request with the explicitly expected origin", () => {
    const baseline = captureRequestIds([]);
    expect(assertExactlyOneNewRequest(baseline, [agentRequest], "agent")).toBe(
      agentRequest,
    );
    expect(() =>
      assertExactlyOneNewRequest(baseline, [agentRequest], "user"),
    ).toThrow(/Expected exactly one new user request/);
    expect(() =>
      assertExactlyOneNewRequest(
        baseline,
        [userRequest, agentRequest],
        "agent",
      ),
    ).toThrow(/found 2/);
  });
});
