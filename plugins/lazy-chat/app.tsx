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
import type {
  ComposerDraftSnapshot,
  PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./rpc";

type Ownership = { messageId: string; threadId: string; turnId: string | null };
type DraftStatus =
  | "loading"
  | "unsaved"
  | "saving"
  | "saved"
  | "error"
  | "conflict"
  | "unavailable"
  | "invalid"
  | "paused";
type DraftConflict = { body: string | null; sha256: string | null };

const pendingReplyFlushes = new Map<string, Promise<void>>();
function roundKey(identity: Ownership): string {
  return JSON.stringify([
    identity.threadId,
    identity.turnId,
    identity.messageId,
  ]);
}

function isComposerDraftEmpty(draft: ComposerDraftSnapshot): boolean {
  return (
    draft.text.trim() === "" &&
    draft.mentions.length === 0 &&
    draft.attachments.length === 0
  );
}
async function waitForRoundFlush(key: string): Promise<void> {
  for (;;) {
    const pending = pendingReplyFlushes.get(key);
    if (!pending) return;
    await pending;
    if (pendingReplyFlushes.get(key) === pending) return;
  }
}

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

function LazyReplyRound({
  message,
  source,
  context,
}: {
  message: PluginMessageDirectiveProps["message"];
  source: string;
  context: string;
}) {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const scopeMatches =
    composer.scope.kind === "thread" &&
    composer.scope.threadId === message.threadId;
  const [eligible, setEligible] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [activityRevision, setActivityRevision] = useState(0);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>("loading");
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  const [contributionBody, setContributionBody] = useState("");
  const savedDraftRef = useRef<string | null>(null);
  const [draftConflict, setDraftConflict] = useState<DraftConflict | null>(
    null,
  );
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
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const mountedRef = useRef(false);
  const eligibleRef = useRef(false);
  const activityRef = useRef(0);
  const validationRef = useRef(0);
  const mutationRef = useRef(0);
  const lastSequenceRef = useRef({ threadId: message.threadId, sequence: -1 });
  const sendingRef = useRef(false);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const latestTextRef = useRef(text);
  const replyRevisionRef = useRef(0);
  const draftHashRef = useRef<string | null>(null);
  const draftLoadedRef = useRef(false);
  const draftDirtyRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const saveBlockedRef = useRef(false);
  const submittedRef = useRef(false);
  const lazySubmitRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadGenerationRef = useRef(0);
  const loadReplyRevisionRef = useRef(replyRevisionRef.current);
  const reconciledRef = useRef(false);
  const conflictRef = useRef<DraftConflict | null>(null);
  const draftStatusRef = useRef<DraftStatus>("loading");
  const setDraftStatusValue = useCallback((value: DraftStatus) => {
    draftStatusRef.current = value;
    setDraftStatus(value);
  }, []);
  const setReplyText = useCallback((value: string) => {
    latestTextRef.current = value;
    setText(value);
  }, []);
  const setConflict = useCallback((value: DraftConflict | null) => {
    conflictRef.current = value;
    setDraftConflict(value);
  }, []);
  const flushSaveRef = useRef<() => Promise<void>>(async () => {});
  const scheduleSaveRef = useRef<() => void>(() => {});

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
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      mountedRef.current = false;
      if (draftDirtyRef.current && !submittedRef.current)
        void flushSaveRef.current();
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
    if (!scopeMatches || message.turnId === null) {
      draftLoadedRef.current = false;
      setDraftLoaded(false);
      setDraftStatusValue(scopeMatches ? "invalid" : "unavailable");
      return;
    }
    const generation = ++loadGenerationRef.current;
    const ownership = { ...ownershipRef.current, turnId: message.turnId };
    loadReplyRevisionRef.current = replyRevisionRef.current;
    reconciledRef.current = false;
    draftHashRef.current = null;
    savedDraftRef.current = null;
    setSavedDraft(null);
    setContributionBody("");
    draftLoadedRef.current = false;
    setDraftLoaded(false);
    setDraftStatusValue("loading");
    setConflict(null);
    void waitForRoundFlush(roundKey(ownership))
      .then(() => {
        if (
          !mountedRef.current ||
          generation !== loadGenerationRef.current ||
          !scopeIsCurrent(ownership)
        )
          return null;
        return rpcRef.current.call("lazy_reply_load", {
          messageId: ownership.messageId,
          threadId: ownership.threadId,
          turnId: ownership.turnId,
        });
      })
      .then((result) => {
        if (
          result === null ||
          !mountedRef.current ||
          generation !== loadGenerationRef.current ||
          !scopeIsCurrent(ownership)
        )
          return;
        if (result.status === "loaded") {
          setContributionBody(result.contributionBody);
          draftHashRef.current = result.draftSha256;
          savedDraftRef.current = result.draftBody;
          setSavedDraft(result.draftBody);
          draftLoadedRef.current = true;
          setDraftLoaded(true);
          setDraftStatusValue(
            result.draftBody === null
              ? "unsaved"
              : result.draftBody === latestTextRef.current ||
                  !eligibleRef.current
                ? "saved"
                : "loading",
          );
          return;
        }
        setDraftStatusValue(
          result.status === "unavailable"
            ? "unavailable"
            : result.status === "invalid_round"
              ? "invalid"
              : "error",
        );
      })
      .catch(() => {
        if (mountedRef.current && generation === loadGenerationRef.current)
          setDraftStatusValue("error");
      });
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [
    message.id,
    message.threadId,
    message.turnId,
    loadAttempt,
    scopeIsCurrent,
    scopeMatches,
    setConflict,
    setDraftStatusValue,
  ]);
  useEffect(() => {
    if (!scopeMatches) return;
    const dispose = composer.onSubmitted(() => {
      if (!lazySubmitRef.current) return;
      submittedRef.current = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      draftDirtyRef.current = false;
      setDraftStatusValue("paused");
    });
    return () => {
      dispose();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      if (draftDirtyRef.current && !submittedRef.current)
        void flushSaveRef.current();
    };
  }, [composer.onSubmitted, scopeMatches, setDraftStatusValue]);
  const flushSave = useCallback(async () => {
    if (
      !draftDirtyRef.current ||
      !draftLoadedRef.current ||
      submittedRef.current ||
      saveBlockedRef.current
    )
      return;
    if (saveInFlightRef.current) return;
    const identity = ownershipRef.current;
    if (identity.turnId === null) return;
    const key = roundKey(identity);
    const previous = pendingReplyFlushes.get(key);
    let release!: () => void;
    const marker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tracked = previous ? previous.then(() => marker) : marker;
    pendingReplyFlushes.set(key, tracked);
    saveInFlightRef.current = true;
    try {
      if (previous) await previous;
      while (
        draftDirtyRef.current &&
        draftLoadedRef.current &&
        !submittedRef.current &&
        !saveBlockedRef.current
      ) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const body = latestTextRef.current;
        const revision = replyRevisionRef.current;
        draftDirtyRef.current = false;
        if (mountedRef.current) setDraftStatusValue("saving");
        let result;
        try {
          result = await rpcRef.current.call("lazy_reply_save", {
            messageId: identity.messageId,
            threadId: identity.threadId,
            turnId: identity.turnId,
            body,
            expectedSha256: draftHashRef.current,
          });
        } catch {
          draftDirtyRef.current = true;
          saveBlockedRef.current = true;
          if (mountedRef.current) setDraftStatusValue("error");
          break;
        }
        if (result.status === "saved") {
          draftHashRef.current = result.sha256;
          savedDraftRef.current = body;
          if (mountedRef.current) setSavedDraft(body);
          if (submittedRef.current) {
            if (mountedRef.current) setDraftStatusValue("paused");
            break;
          }
          if (
            revision === replyRevisionRef.current &&
            body === latestTextRef.current
          ) {
            saveBlockedRef.current = false;
            if (mountedRef.current) setDraftStatusValue("saved");
            break;
          }
          draftDirtyRef.current = true;
        } else if (result.status === "conflict") {
          draftHashRef.current = result.diskSha256;
          draftDirtyRef.current = false;
          saveBlockedRef.current = true;
          const conflict = {
            body: result.diskBody,
            sha256: result.diskSha256,
          };
          conflictRef.current = conflict;
          if (mountedRef.current) setConflict(conflict);
          if (mountedRef.current) setDraftStatusValue("conflict");
        } else {
          draftDirtyRef.current = true;
          saveBlockedRef.current = true;
          if (mountedRef.current)
            setDraftStatusValue(
              result.status === "unavailable" ? "unavailable" : "error",
            );
        }
      }
    } finally {
      saveInFlightRef.current = false;
      release();
      if (pendingReplyFlushes.get(key) === tracked)
        pendingReplyFlushes.delete(key);
    }
  }, [setConflict, setDraftStatusValue]);
  flushSaveRef.current = flushSave;
  const scheduleSave = useCallback(() => {
    if (saveBlockedRef.current || submittedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flushSaveRef.current();
    }, 250);
  }, []);
  scheduleSaveRef.current = scheduleSave;

  const operationIsCurrent = useCallback(
    (ownership: Ownership, activity: number, mutation: number) =>
      mountedRef.current &&
      activityRef.current === activity &&
      mutationRef.current === mutation &&
      connectionRef.current === "connected" &&
      scopeIsCurrent(ownership),
    [scopeIsCurrent],
  );
  useEffect(() => {
    if (!draftLoaded || !eligible || !scopeMatches || message.turnId === null)
      return;
    if (reconciledRef.current) return;
    reconciledRef.current = true;
    const body = savedDraftRef.current;
    if (body === null) {
      if (latestTextRef.current !== "") {
        draftDirtyRef.current = true;
        setDraftStatusValue("unsaved");
        scheduleSaveRef.current();
      }
      return;
    }
    if (body === latestTextRef.current) {
      setDraftStatusValue("saved");
      return;
    }
    const canRestore =
      latestTextRef.current === "" &&
      replyRevisionRef.current === loadReplyRevisionRef.current;
    if (!canRestore) {
      const conflict = { body, sha256: draftHashRef.current };
      saveBlockedRef.current = true;
      setConflict(conflict);
      setDraftStatusValue("conflict");
      return;
    }
    replyRevisionRef.current += 1;
    setReplyText(body);
    setDraftStatusValue("saved");
  }, [
    draftLoaded,
    eligible,
    message.turnId,
    scopeMatches,
    setConflict,
    setDraftStatusValue,
    setReplyText,
  ]);

  const updateReply = useCallback(
    (next: string) => {
      if (!eligibleRef.current || sendingRef.current) return;
      if (submittedRef.current) submittedRef.current = false;
      if (!scopeIsCurrent(ownershipRef.current)) return;
      setReplyText(next);
      replyRevisionRef.current += 1;
      draftDirtyRef.current = true;
      if (!saveBlockedRef.current) {
        setDraftStatusValue("unsaved");
        scheduleSaveRef.current();
      }
    },
    [scopeIsCurrent, setDraftStatusValue, setReplyText],
  );
  const insertQuote = useCallback(() => {
    if (!eligibleRef.current || sendingRef.current || submittedRef.current)
      return;
    const ownership = { ...ownershipRef.current };
    const activity = activityRef.current;
    const mutation = ++mutationRef.current;
    if (!scopeIsCurrent(ownership)) return;
    void checkEligibility().then((isEligible) => {
      if (!isEligible || !operationIsCurrent(ownership, activity, mutation))
        return;
      const quote = "> Lazy Chat quote probe";
      updateReply(
        latestTextRef.current ? `${latestTextRef.current}\n\n${quote}` : quote,
      );
    });
  }, [checkEligibility, operationIsCurrent, scopeIsCurrent, updateReply]);
  const submit = async () => {
    if (!eligibleRef.current || sendingRef.current || submittedRef.current)
      return;
    const ownership = { ...ownershipRef.current };
    const activity = activityRef.current;
    const mutation = ++mutationRef.current;
    if (!scopeIsCurrent(ownership)) return;
    const reply = latestTextRef.current;
    if (!reply.trim()) {
      setError("Add a reply before sending.");
      return;
    }
    if (!composerRef.current.isEmpty) {
      setError(
        "Clear the main composer before sending. Its draft and attachments were left untouched.",
      );
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    let lockedComposer: typeof composer | null = null;
    let staged = false;
    try {
      const isEligible = await checkEligibility();
      if (!isEligible || !operationIsCurrent(ownership, activity, mutation))
        return;

      if (
        draftDirtyRef.current ||
        savedDraftRef.current !== reply ||
        draftStatusRef.current !== "saved"
      ) {
        await flushSaveRef.current();
        if (
          latestTextRef.current !== reply ||
          savedDraftRef.current !== reply ||
          draftStatusRef.current !== "saved"
        ) {
          setError("Save the Lazy Chat reply before sending it.");
          return;
        }
      }

      if (!operationIsCurrent(ownership, activity, mutation)) return;
      lockedComposer = composerRef.current;
      if (!lockedComposer.isEmpty) {
        setError(
          "Clear the main composer before sending. Its draft and attachments were left untouched.",
        );
        return;
      }
      lockedComposer.setInputLock(true);
      lockedComposer.replace((current) => {
        if (!isComposerDraftEmpty(current)) return current;
        staged = true;
        return { text: reply, mentions: [] };
      });
      if (!staged) {
        setError(
          "Clear the main composer before sending. Its draft and attachments were left untouched.",
        );
        return;
      }
      lazySubmitRef.current = true;
      await lockedComposer.submit({ experimental_data: null });
    } catch (cause) {
      if (staged && lockedComposer && !submittedRef.current) {
        try {
          lockedComposer.replace((current) =>
            current.text === reply &&
            current.mentions.length === 0 &&
            current.attachments.length === 0
              ? { text: "", mentions: [] }
              : current,
          );
        } catch {
          // Keep the durable inline reply if the composer scope disappeared.
        }
      }
      if (mountedRef.current && scopeIsCurrent(ownership))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lazySubmitRef.current = false;
      if (lockedComposer) {
        try {
          lockedComposer.setInputLock(false);
        } catch {
          // The host may have already disposed this composer scope.
        }
      }
      sendingRef.current = false;
      if (mountedRef.current) setSending(false);
    }
  };
  const keepLocalReply = () => {
    const conflict = conflictRef.current;
    if (!conflict) return;
    draftHashRef.current = conflict.sha256;
    saveBlockedRef.current = false;
    setConflict(null);
    draftDirtyRef.current = true;
    setDraftStatusValue("unsaved");
    void flushSaveRef.current();
  };
  const useSavedReply = async () => {
    const conflict = conflictRef.current;
    if (!conflict || conflict.body === null || !eligibleRef.current) return;
    const ownership = { ...ownershipRef.current };
    const activity = activityRef.current;
    const mutation = ++mutationRef.current;
    const observedReplyRevision = replyRevisionRef.current;
    const isEligible = await checkEligibility();
    if (!isEligible || !operationIsCurrent(ownership, activity, mutation))
      return;
    if (replyRevisionRef.current !== observedReplyRevision) return;
    draftHashRef.current = conflict.sha256;
    savedDraftRef.current = conflict.body;
    setSavedDraft(conflict.body);
    setReplyText(conflict.body);
    replyRevisionRef.current += 1;
    draftDirtyRef.current = false;
    saveBlockedRef.current = false;
    setConflict(null);
    setDraftStatusValue("saved");
  };
  const retrySave = () => {
    saveBlockedRef.current = false;
    draftDirtyRef.current = true;
    setDraftStatusValue("unsaved");
    void flushSaveRef.current();
  };
  const retryLoad = () => {
    draftLoadedRef.current = false;
    setDraftLoaded(false);
    setDraftStatusValue("loading");
    setLoadAttempt((attempt) => attempt + 1);
  };

  if (!scopeMatches)
    return (
      <p role="status">
        Reply editor is unavailable because the active composer is not this
        thread.
      </p>
    );
  if (!eligible) {
    if (draftLoaded && savedDraft !== null)
      return (
        <section
          aria-label="Saved reply (read only)"
          className="grid w-full max-w-[720px] gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
        >
          <label>
            Saved reply (read only)
            <textarea
              aria-label="Saved reply (read only)"
              readOnly
              value={savedDraft}
              className="mt-1.5 block w-full min-w-0 resize-y rounded-md border border-border bg-background p-2.5 text-foreground"
            />
          </label>
          <p role="status">Saved reply for this earlier contribution.</p>
        </section>
      );
    if (draftStatus === "error" || draftStatus === "unavailable")
      return (
        <div>
          <p role="status">
            {draftStatus === "unavailable"
              ? "Thread storage is unavailable; this reply is not persisted."
              : "The saved reply could not be loaded."}
          </p>
          <button type="button" onClick={retryLoad}>
            Retry thread-storage load
          </button>
        </div>
      );
    return (
      <p role="status">
        {draftStatus === "loading"
          ? "Loading saved reply…"
          : (error ?? "Reply editor is unavailable for this contribution.")}
      </p>
    );
  }
  const fallbackContext = source
    ? contributionBody.replaceAll(source, "").trim()
    : contributionBody.trim();
  const rawContext = context.trim() || fallbackContext;
  const contextTruncated = rawContext.length > 4000;
  const displayContext = rawContext.slice(0, 4000);
  const statusText = {
    loading: "Loading saved reply…",
    unsaved: "Reply changes are not yet saved.",
    saving: "Saving reply to thread storage…",
    saved: "Saved to thread storage.",
    error: "Reply save failed. Your text is preserved here.",
    conflict: "A different saved reply exists. Choose which version to keep.",
    unavailable: "Thread storage is unavailable. This reply is not persisted.",
    invalid: "This contribution cannot own a reply draft.",
    paused:
      "Autosave paused after local submission. Provider delivery is not confirmed.",
  }[draftStatus];
  return (
    <section
      aria-label="Lazy Chat reply"
      data-thread-id={message.threadId}
      data-message-id={message.id}
      className="grid w-full max-w-[720px] gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      {displayContext ? (
        <div
          aria-label="Reply context"
          className="rounded-md border border-border bg-muted p-3"
        >
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Context
          </p>
          <p className="m-0 whitespace-pre-wrap break-words text-sm text-foreground">
            {displayContext}
          </p>
          {contextTruncated ? (
            <p className="mb-0 mt-2 text-xs text-muted-foreground">
              Context was truncated to 4,000 characters.
            </p>
          ) : null}
        </div>
      ) : null}
      <label>
        Reply draft
        <textarea
          aria-label="Reply draft"
          rows={6}
          disabled={sending}
          className="mt-1.5 block min-h-[140px] w-full min-w-0 resize-y rounded-md border border-border bg-background p-2.5 font-[inherit] text-foreground"
          value={text}
          onChange={(event) => updateReply(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={sending || submittedRef.current}
          className="rounded-md border border-border bg-secondary px-2.5 py-1.5 text-secondary-foreground hover:bg-accent"
          onClick={insertQuote}
        >
          Insert quote
        </button>
        <button
          type="button"
          className="rounded-md border border-primary bg-primary px-3 py-2 text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void submit()}
          disabled={sending || submittedRef.current}
        >
          {sending ? "Sending…" : "Send reply"}
        </button>
      </div>
      <p role="status">{statusText}</p>

      {draftStatus === "conflict" && draftConflict ? (
        <div>
          <p role="alert">
            {draftConflict.body === null
              ? "The saved file changed or was removed while your local reply changed."
              : `Saved version: ${draftConflict.body}`}
          </p>
          <button type="button" onClick={keepLocalReply}>
            Keep local reply
          </button>
          {draftConflict.body !== null ? (
            <button type="button" onClick={() => void useSavedReply()}>
              Use saved reply
            </button>
          ) : null}
        </div>
      ) : null}
      {draftStatus === "error" || draftStatus === "unavailable" ? (
        <button type="button" onClick={draftLoaded ? retrySave : retryLoad}>
          {draftLoaded ? "Retry save" : "Retry thread-storage load"}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function LazyReply(props: PluginMessageDirectiveProps) {
  const { message } = props;
  const context = props.attributes.context ?? "";
  const key = JSON.stringify([message.threadId, message.turnId, message.id]);
  return (
    <LazyReplyRound
      key={key}
      message={message}
      source={props.source}
      context={context}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "lazy-reply", component: LazyReply });
});
