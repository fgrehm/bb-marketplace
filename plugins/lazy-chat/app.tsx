import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  definePluginApp,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Ownership = { messageId: string; threadId: string; turnId: string | null };

function isThreadActivity(payload: unknown): payload is {
  threadId: string;
  sequence: number;
} {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  return (
    typeof value.threadId === "string" &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence)
  );
}

export function LazyReply({ message }: PluginMessageDirectiveProps) {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const scopeMatches =
    composer.scope.kind === "thread" &&
    composer.scope.threadId === message.threadId;
  const [eligible, setEligible] = useState(false);
  const [text, setText] = useState(scopeMatches ? composer.text : "");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [activityRevision, setActivityRevision] = useState(0);
  const ownershipRef = useRef<Ownership>({
    messageId: message.id,
    threadId: message.threadId,
    turnId: message.turnId,
  });
  ownershipRef.current = {
    messageId: message.id,
    threadId: message.threadId,
    turnId: message.turnId,
  };
  const scopeRef = useRef(composer.scope);
  scopeRef.current = composer.scope;
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const observedDraftRef = useRef(composer.text);
  const draftRevisionRef = useRef(0);
  if (observedDraftRef.current !== composer.text) {
    observedDraftRef.current = composer.text;
    draftRevisionRef.current += 1;
  }
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const mountedRef = useRef(false);
  const eligibleRef = useRef(false);
  const activityRef = useRef(0);
  const validationRef = useRef(0);
  const mutationRef = useRef(0);
  const lastSequenceRef = useRef({ threadId: message.threadId, sequence: -1 });
  const sendingRef = useRef(false);

  const setEligibility = useCallback((value: boolean) => {
    eligibleRef.current = value;
    setEligible(value);
  }, []);
  const scopeIsCurrent = useCallback((ownership: Ownership) => {
    const scope = scopeRef.current;
    return (
      ownershipRef.current.messageId === ownership.messageId &&
      ownershipRef.current.threadId === ownership.threadId &&
      ownershipRef.current.turnId === ownership.turnId &&
      scope.kind === "thread" &&
      scope.threadId === ownership.threadId
    );
  }, []);
  const invalidate = useCallback(() => {
    activityRef.current += 1;
    validationRef.current += 1;
    mutationRef.current += 1;
    if (mountedRef.current) setEligibility(false);
    setActivityRevision((revision) => revision + 1);
  }, [setEligibility]);
  const onThreadActivity = useCallback(
    (payload: unknown) => {
      if (!isThreadActivity(payload)) return;
      if (payload.threadId !== ownershipRef.current.threadId) return;
      if (lastSequenceRef.current.threadId !== payload.threadId)
        lastSequenceRef.current = { threadId: payload.threadId, sequence: -1 };
      if (payload.sequence <= lastSequenceRef.current.sequence) return;
      lastSequenceRef.current.sequence = payload.sequence;
      invalidate();
    },
    [invalidate],
  );
  useRealtime("thread-activity", onThreadActivity);

  const checkEligibility = useCallback(async (): Promise<boolean> => {
    const validation = ++validationRef.current;
    const activity = activityRef.current;
    const ownership = { ...ownershipRef.current };
    const isCurrent = () =>
      mountedRef.current &&
      validationRef.current === validation &&
      activityRef.current === activity &&
      connectionRef.current === "connected" &&
      scopeIsCurrent(ownership);
    if (
      !mountedRef.current ||
      ownership.turnId === null ||
      connectionRef.current !== "connected" ||
      !scopeIsCurrent(ownership)
    ) {
      if (mountedRef.current && validationRef.current === validation)
        setEligibility(false);
      return false;
    }
    try {
      const result = await rpc.call("lazy_reply_eligible", {
        messageId: ownership.messageId,
        threadId: ownership.threadId,
        turnId: ownership.turnId,
      });
      if (!isCurrent()) return false;
      setEligibility(result.eligible);
      if (result.eligible) setError(null);
      return result.eligible;
    } catch (cause) {
      if (isCurrent()) {
        setEligibility(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return false;
    }
  }, [rpc, scopeIsCurrent, setEligibility]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activityRef.current += 1;
      validationRef.current += 1;
      mutationRef.current += 1;
      eligibleRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!scopeMatches || message.turnId === null) {
      setEligibility(false);
      return;
    }
    void checkEligibility();
    return () => {
      validationRef.current += 1;
      mutationRef.current += 1;
      eligibleRef.current = false;
    };
  }, [
    activityRevision,
    checkEligibility,
    message.id,
    message.threadId,
    message.turnId,
    scopeMatches,
    setEligibility,
  ]);
  const previousConnectionRef = useRef(connection);
  useEffect(() => {
    const previous = previousConnectionRef.current;
    previousConnectionRef.current = connection;
    if (previous !== connection) invalidate();
  }, [connection, invalidate]);
  useEffect(() => {
    if (scopeMatches) setText(composer.text);
  }, [composer.text, scopeMatches]);

  const operationIsCurrent = useCallback(
    (ownership: Ownership, activity: number, mutation: number) =>
      mountedRef.current &&
      activityRef.current === activity &&
      mutationRef.current === mutation &&
      connectionRef.current === "connected" &&
      scopeIsCurrent(ownership),
    [scopeIsCurrent],
  );
  const setSharedText = useCallback(
    (next: string) => {
      if (!eligibleRef.current || sendingRef.current) return;
      const ownership = { ...ownershipRef.current };
      const activity = activityRef.current;
      const mutation = ++mutationRef.current;
      const observedDraft = composerRef.current.text;
      const draftRevision = draftRevisionRef.current;
      if (!scopeIsCurrent(ownership)) return;
      setText(next);
      void checkEligibility().then((isEligible) => {
        if (!isEligible || !operationIsCurrent(ownership, activity, mutation))
          return;
        if (
          draftRevisionRef.current !== draftRevision ||
          composerRef.current.text !== observedDraft
        ) {
          setText(composerRef.current.text);
          return;
        }
        composerRef.current.updateText((current) => {
          if (current !== observedDraft) {
            setText(current);
            return current;
          }
          return next;
        });
      });
    },
    [checkEligibility, operationIsCurrent, scopeIsCurrent],
  );
  const insertQuote = useCallback(() => {
    if (!eligibleRef.current || sendingRef.current) return;
    const ownership = { ...ownershipRef.current };
    const activity = activityRef.current;
    const mutation = ++mutationRef.current;
    if (!scopeIsCurrent(ownership)) return;
    void checkEligibility().then((isEligible) => {
      if (!isEligible || !operationIsCurrent(ownership, activity, mutation))
        return;
      composerRef.current.addQuote("Lazy Chat quote probe");
    });
  }, [checkEligibility, operationIsCurrent, scopeIsCurrent]);
  const submit = async () => {
    if (!eligibleRef.current || sendingRef.current) return;
    const ownership = { ...ownershipRef.current };
    const activity = activityRef.current;
    const mutation = ++mutationRef.current;
    if (!scopeIsCurrent(ownership)) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const isEligible = await checkEligibility();
      if (!isEligible || !operationIsCurrent(ownership, activity, mutation))
        return;
      await composerRef.current.experimental_submit({
        experimental_data: null,
      });
    } catch (cause) {
      if (mountedRef.current && scopeIsCurrent(ownership))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setSending(false);
    }
  };

  if (!scopeMatches)
    return (
      <p role="status">
        Reply editor is unavailable because the active composer is not this
        thread.
      </p>
    );
  if (!eligible)
    return (
      <p role="status">
        {error ?? "Reply editor is unavailable for this contribution."}
      </p>
    );
  return (
    <section
      aria-label="Lazy Chat reply"
      data-thread-id={message.threadId}
      data-message-id={message.id}
      style={{
        display: "grid",
        width: "min(100%, 720px)",
        boxSizing: "border-box",
        gap: 12,
        maxWidth: 720,
        padding: 16,
        border: "1px solid #888",
        borderRadius: 8,
        background: "#fff",
        color: "#222",
      }}
    >
      <label>
        Reply draft
        <textarea
          aria-label="Reply draft"
          rows={6}
          disabled={sending}
          style={{
            display: "block",
            boxSizing: "border-box",
            width: "100%",
            minWidth: 0,
            minHeight: 140,
            marginTop: 6,
            padding: 10,
            resize: "vertical",
            font: "inherit",
            color: "inherit",
            background: "#fff",
            border: "1px solid #777",
            borderRadius: 4,
          }}
          value={text}
          onChange={(event) => setSharedText(event.target.value)}
        />
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          disabled={sending}
          style={{
            padding: "6px 10px",
            border: "1px solid #666",
            borderRadius: 4,
            background: "#f5f5f5",
            color: "#222",
          }}
          onClick={insertQuote}
        >
          Insert quote probe
        </button>
        <button
          type="button"
          style={{
            padding: "7px 12px",
            border: "1px solid #222",
            borderRadius: 4,
            background: "#222",
            color: "#fff",
          }}
          onClick={() => void submit()}
          disabled={sending}
        >
          {sending ? "Sending…" : "Send reply"}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "lazy-reply", component: LazyReply });
});
