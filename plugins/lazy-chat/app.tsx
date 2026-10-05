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

function LazyReplyRound({ message }: PluginMessageDirectiveProps) {
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
  const [draftStatus, setDraftStatus] = useState<DraftStatus>("loading");
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [requiresAdoption, setRequiresAdoption] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
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
  const roundInitialNativeTextRef = useRef(composer.text);
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
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const latestTextRef = useRef(text);
  const replyRevisionRef = useRef(0);
  const draftHashRef = useRef<string | null>(null);
  const draftLoadedRef = useRef(false);
  const draftDirtyRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const saveBlockedRef = useRef(false);
  const adoptionRequiredRef = useRef(false);
  const submittedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadGenerationRef = useRef(0);
  const loadNativeTextRef = useRef(composer.text);
  const loadDraftRevisionRef = useRef(draftRevisionRef.current);
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
  const setAdoptionRequired = useCallback((value: boolean) => {
    adoptionRequiredRef.current = value;
    setRequiresAdoption(value);
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
    loadNativeTextRef.current = composerRef.current.text;
    loadDraftRevisionRef.current = draftRevisionRef.current;
    loadReplyRevisionRef.current = replyRevisionRef.current;
    reconciledRef.current = false;
    draftHashRef.current = null;
    savedDraftRef.current = null;
    setSavedDraft(null);
    draftLoadedRef.current = false;
    setDraftLoaded(false);
    setDraftStatusValue("loading");
    setConflict(null);
    setAdoptionRequired(false);
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
          draftHashRef.current = result.draftSha256;
          savedDraftRef.current = result.draftBody;
          setSavedDraft(result.draftBody);
          draftLoadedRef.current = true;
          setDraftLoaded(true);
          if (
            result.draftBody === null &&
            roundInitialNativeTextRef.current !== ""
          ) {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
            draftDirtyRef.current = false;
            setAdoptionRequired(true);
          }
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
    setAdoptionRequired,
    setConflict,
    setDraftStatusValue,
  ]);
  useEffect(() => {
    if (!scopeMatches) return;
    const dispose = composer.experimental_onSubmitted(() => {
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
  }, [composer.experimental_onSubmitted, scopeMatches, setDraftStatusValue]);
  useEffect(() => {
    if (!scopeMatches || !eligibleRef.current) return;
    if (submittedRef.current) {
      if (composer.text === "") return;
      submittedRef.current = false;
    }
    if (latestTextRef.current === composer.text) return;
    setDraftStatusValue("unsaved");
    draftRevisionRef.current += 1;
    replyRevisionRef.current += 1;
    setReplyText(composer.text);
    if (draftLoadedRef.current) {
      draftDirtyRef.current = true;
      if (eligibleRef.current && !saveBlockedRef.current) {
        setDraftStatusValue("unsaved");
        scheduleSaveRef.current();
      }
    }
  }, [
    composer.text,
    eligible,
    scopeMatches,
    setDraftStatusValue,
    setReplyText,
  ]);

  const flushSave = useCallback(async () => {
    if (
      !draftDirtyRef.current ||
      !draftLoadedRef.current ||
      adoptionRequiredRef.current ||
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
        !adoptionRequiredRef.current &&
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
      if (roundInitialNativeTextRef.current !== "") return;
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
      loadNativeTextRef.current === "" &&
      composerRef.current.text === "" &&
      latestTextRef.current === "" &&
      draftRevisionRef.current === loadDraftRevisionRef.current &&
      replyRevisionRef.current === loadReplyRevisionRef.current;
    if (!canRestore) {
      const conflict = { body, sha256: draftHashRef.current };
      saveBlockedRef.current = true;
      setConflict(conflict);
      setDraftStatusValue("conflict");
      return;
    }
    const ownership = { ...ownershipRef.current };
    const activity = activityRef.current;
    const mutation = ++mutationRef.current;
    const baseline = composerRef.current.text;
    const nativeRevision = draftRevisionRef.current;
    const replyRevision = replyRevisionRef.current;
    void checkEligibility().then((isEligible) => {
      if (!isEligible || !operationIsCurrent(ownership, activity, mutation))
        return;
      let applied = false;
      composerRef.current.updateText((current) => {
        if (
          current !== baseline ||
          draftRevisionRef.current !== nativeRevision ||
          replyRevisionRef.current !== replyRevision ||
          !scopeIsCurrent(ownership)
        )
          return current;
        applied = true;
        return body;
      });
      if (applied) {
        replyRevisionRef.current += 1;
        setReplyText(body);
        setDraftStatusValue("saved");
      } else {
        saveBlockedRef.current = true;
        setConflict({ body, sha256: draftHashRef.current });
        setDraftStatusValue("conflict");
      }
    });
  }, [
    checkEligibility,
    draftLoaded,
    eligible,
    message.turnId,
    operationIsCurrent,
    scopeIsCurrent,
    scopeMatches,
    setConflict,
    setDraftStatusValue,
    setReplyText,
  ]);

  const setSharedText = useCallback(
    (next: string) => {
      if (!eligibleRef.current || sendingRef.current) return;
      if (submittedRef.current) {
        submittedRef.current = false;
        setDraftStatusValue("unsaved");
      }
      const ownership = { ...ownershipRef.current };
      const activity = activityRef.current;
      const mutation = ++mutationRef.current;
      const observedDraft = composerRef.current.text;
      const draftRevision = draftRevisionRef.current;
      if (!scopeIsCurrent(ownership)) return;
      setReplyText(next);
      replyRevisionRef.current += 1;
      draftDirtyRef.current = true;
      if (!saveBlockedRef.current) {
        setDraftStatusValue("unsaved");
        scheduleSaveRef.current();
      }
      void checkEligibility().then((isEligible) => {
        if (!isEligible || !operationIsCurrent(ownership, activity, mutation))
          return;
        if (
          draftRevisionRef.current !== draftRevision ||
          composerRef.current.text !== observedDraft
        ) {
          setReplyText(composerRef.current.text);
          return;
        }
        composerRef.current.updateText((current) => {
          if (current !== observedDraft) {
            setReplyText(current);
            return current;
          }
          return next;
        });
      });
    },
    [
      checkEligibility,
      operationIsCurrent,
      scopeIsCurrent,
      setDraftStatusValue,
      setReplyText,
    ],
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
      composerRef.current.addQuote("Lazy Chat quote probe");
    });
  }, [checkEligibility, operationIsCurrent, scopeIsCurrent]);
  const submit = async () => {
    if (!eligibleRef.current || sendingRef.current || submittedRef.current)
      return;
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

  const adoptCurrentDraft = () => {
    if (
      !eligibleRef.current ||
      !draftLoadedRef.current ||
      savedDraftRef.current !== null
    )
      return;
    setAdoptionRequired(false);
    draftDirtyRef.current = true;
    setDraftStatusValue("unsaved");
    scheduleSaveRef.current();
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
    const observedNative = composerRef.current.text;
    const observedRevision = draftRevisionRef.current;
    const observedReplyRevision = replyRevisionRef.current;
    const isEligible = await checkEligibility();
    if (!isEligible || !operationIsCurrent(ownership, activity, mutation))
      return;
    let applied = false;
    composerRef.current.updateText((current) => {
      if (
        current !== observedNative ||
        draftRevisionRef.current !== observedRevision ||
        replyRevisionRef.current !== observedReplyRevision
      )
        return current;
      applied = true;
      return conflict.body!;
    });
    if (!applied) return;
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
        <section aria-label="Saved reply (read only)">
          <label>
            Saved reply (read only)
            <textarea
              aria-label="Saved reply (read only)"
              readOnly
              value={savedDraft}
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
              ? "Workspace storage is unavailable; this reply is not persisted."
              : "The saved reply could not be loaded."}
          </p>
          <button type="button" onClick={retryLoad}>
            Retry workspace load
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
  const statusText = {
    loading: "Loading saved reply…",
    unsaved: "Reply changes are not yet saved.",
    saving: "Saving reply to workspace Markdown…",
    saved: "Saved to workspace Markdown.",
    error: "Reply save failed. Your text is preserved here.",
    conflict: "A different saved reply exists. Choose which version to keep.",
    unavailable:
      "Workspace storage is unavailable. This reply is not persisted.",
    invalid: "This contribution cannot own a reply draft.",
    paused:
      "Autosave paused after local submission. Provider delivery is not confirmed.",
  }[draftStatus];
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
          disabled={sending || submittedRef.current}
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
          disabled={sending || submittedRef.current}
        >
          {sending ? "Sending…" : "Send reply"}
        </button>
      </div>
      <p role="status">{statusText}</p>
      {requiresAdoption ? (
        <div>
          <p role="status">
            The current composer text predates this reply. It will not be saved
            for this round unless you adopt it.
          </p>
          <button type="button" onClick={adoptCurrentDraft}>
            Use current draft for this reply
          </button>
        </div>
      ) : null}
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
          {draftLoaded ? "Retry save" : "Retry workspace load"}
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

export function LazyReply(props: PluginMessageDirectiveProps) {
  const { message } = props;
  const key = JSON.stringify([message.threadId, message.turnId, message.id]);
  return <LazyReplyRound key={key} {...props} />;
}

export default definePluginApp((app) => {
  app.slots.messageDirective({ id: "lazy-reply", component: LazyReply });
});
