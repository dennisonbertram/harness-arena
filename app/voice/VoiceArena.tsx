"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import {
  appendExclude,
  buildJudgmentPayload,
  initialVoiceFlowState,
  isActiveState,
  parseJudgmentResponse,
  parseNextResponse,
  voiceFlowReducer,
  voiceNextUrl,
  type ClipKey,
  type JudgmentPayload,
  type VoiceOutcome,
} from "@/lib/voice-flow";
import { VOICE_JUDGMENT_REASONS } from "@/lib/voice-types";

const REASON_LABELS: Record<(typeof VOICE_JUDGMENT_REASONS)[number], string> = {
  better_answer: "Better answer",
  more_natural_voice: "More natural voice",
  better_tone: "Better tone or emotion",
  better_pacing: "Better pacing",
  better_pronunciation: "Better pronunciation",
  more_concise: "More concise",
  other: "Other",
  not_sure: "Not sure",
};

const OUTCOME_LABELS: Record<VoiceOutcome, string> = { a: "A", b: "B", tie: "Tie", both_bad: "Both bad" };

export default function VoiceArena() {
  const [state, dispatch] = useReducer(voiceFlowReducer, initialVoiceFlowState);
  const [nextFetchError, setNextFetchError] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const audioPromptRef = useRef<HTMLAudioElement>(null);
  const audioARef = useRef<HTMLAudioElement>(null);
  const audioBRef = useRef<HTMLAudioElement>(null);
  // "Play both" arms B to auto-start from A's `ended` event; a plain replay
  // of A alone must not trigger it.
  const playBothArmedRef = useRef(false);

  async function loadNext(excludeIds: string[]) {
    setNextFetchError(false);
    try {
      const res = await fetch(voiceNextUrl(excludeIds));
      const result = await parseNextResponse(res);
      if (result.kind === "not_seeded") dispatch({ type: "notSeeded" });
      else if (result.kind === "done") dispatch({ type: "allDone", progress: result.progress });
      else if (result.kind === "comparison")
        dispatch({ type: "loaded", comparison: result.comparison, loadedAt: Date.now() });
      else setNextFetchError(true);
    } catch {
      setNextFetchError(true);
    }
  }

  useEffect(() => {
    // Runs once on mount; every later refetch is triggered explicitly right
    // after the action that causes it (skip, submit success, submit rejection).
    (async () => {
      await loadNext([]);
    })();
  }, []);

  const activeComparisonId = isActiveState(state) ? state.comparison.comparisonId : null;
  useEffect(() => {
    if (activeComparisonId) headingRef.current?.focus();
  }, [activeComparisonId]);

  async function runSubmit(payload: JudgmentPayload, comparisonId: string, excludeIds: string[]) {
    try {
      const res = await fetch("/api/voice/judgments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await parseJudgmentResponse(res);
      if (result.kind === "stored") {
        const nextExclude = appendExclude(excludeIds, comparisonId);
        dispatch({ type: "submitSucceeded", comparisonId });
        loadNext(nextExclude);
      } else if (result.kind === "retryable") {
        dispatch({ type: "submitFailedRetryable", message: result.message });
      } else {
        dispatch({ type: "submitFailedRejected", message: result.message });
        loadNext(excludeIds);
      }
    } catch {
      dispatch({ type: "submitFailedRetryable", message: "Could not reach the server. Try again." });
    }
  }

  function handleSubmit() {
    if (!isActiveState(state) || state.phase !== "diagnostic") return;
    const payload = buildJudgmentPayload(state);
    if (!payload) return;
    const { comparisonId } = state.comparison;
    const { excludeIds } = state;
    dispatch({ type: "submit" });
    runSubmit(payload, comparisonId, excludeIds);
  }

  function handleRetry() {
    if (!isActiveState(state) || !state.pendingPayload) return;
    const payload = state.pendingPayload;
    const { comparisonId } = state.comparison;
    const { excludeIds } = state;
    dispatch({ type: "retrySubmit" });
    runSubmit(payload, comparisonId, excludeIds);
  }

  function handleSkip() {
    if (!isActiveState(state)) return;
    const { comparisonId } = state.comparison;
    const nextExclude = appendExclude(state.excludeIds, comparisonId);
    dispatch({ type: "skip", comparisonId });
    loadNext(nextExclude);
  }

  function handlePlayBoth() {
    const a = audioARef.current;
    const b = audioBRef.current;
    if (!a || !b) return;
    // Safari/iOS requires a user gesture on the exact element that plays.
    // Prime B synchronously right here (play, then immediately pause)
    // before starting A, so B's later play() from A's `ended` handler —
    // which is not itself a user gesture — is still allowed. Load-bearing.
    playBothArmedRef.current = true;
    b.play().catch(() => {});
    b.pause();
    a.currentTime = 0;
    a.play().catch(() => {});
  }

  function handleAEnded() {
    if (playBothArmedRef.current) {
      playBothArmedRef.current = false;
      audioBRef.current?.play().catch(() => {});
    }
  }

  function retryClip(clip: ClipKey) {
    const ref = clip === "prompt" ? audioPromptRef : clip === "a" ? audioARef : audioBRef;
    ref.current?.load();
    dispatch({ type: "clearAudioError" });
  }

  if (state.phase === "not_seeded") {
    return (
      <div style={panelStyle}>
        <p style={{ fontSize: 15 }}>Voice Arena isn&apos;t seeded yet.</p>
      </div>
    );
  }

  if (state.phase === "done") {
    return (
      <div style={panelStyle}>
        <p style={{ fontSize: 15, marginBottom: 8 }}>You&apos;ve judged every available comparison — thank you.</p>
        <Link href="/voice/results" style={{ color: "var(--blue-700)" }}>
          View results →
        </Link>
      </div>
    );
  }

  if (state.phase === "pending") {
    return (
      <div style={panelStyle}>
        {state.notice ? <p style={{ fontSize: 13, color: "var(--gray-700)", marginBottom: 12 }}>{state.notice}</p> : null}
        <PendingPlaceholder />
        {nextFetchError ? (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 13, color: "var(--red-700)", marginBottom: 8 }}>Could not load the next comparison.</p>
            <button type="button" onClick={() => loadNext(state.excludeIds)} style={secondaryButtonStyle}>
              Try again
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const { comparison, playCounts, audioError, outcome, reason, freeText, submitError, phase } = state;
  const submitting = phase === "submitting";
  const readyToSubmit = phase === "diagnostic";

  return (
    <div style={panelStyle}>
      <div aria-live="polite" style={srOnlyStyle}>
        {`Comparison ${comparison.progress.judged + 1}`}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 ref={headingRef} tabIndex={-1} style={{ fontSize: 18, fontWeight: 600, outline: "none" }}>
          Comparison {comparison.progress.batch.position} of {comparison.progress.batch.size}
        </h2>
        <span className="tabular-nums" style={{ fontSize: 12, color: "var(--gray-700)" }}>
          {comparison.progress.judged} of {comparison.progress.total} judged
        </span>
      </div>

      <ClipPlayer
        label="Prompt"
        audioRef={audioPromptRef}
        src={comparison.prompt.audioUrl}
        error={audioError === "prompt"}
        onPlay={() => dispatch({ type: "played", clip: "prompt" })}
        onError={() => dispatch({ type: "audioErrored", clip: "prompt" })}
        onRetry={() => retryClip("prompt")}
        onSkip={handleSkip}
      />
      {comparison.prompt.text ? (
        <p style={{ fontSize: 13, color: "var(--gray-700)", margin: "4px 0 16px" }}>&quot;{comparison.prompt.text}&quot;</p>
      ) : (
        <div style={{ marginBottom: 16 }} />
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 12 }}>
        <ClipPlayer
          label="Response A"
          audioRef={audioARef}
          src={comparison.clipA.audioUrl}
          error={audioError === "a"}
          onPlay={() => dispatch({ type: "played", clip: "a" })}
          onEnded={handleAEnded}
          onError={() => dispatch({ type: "audioErrored", clip: "a" })}
          onRetry={() => retryClip("a")}
          onSkip={handleSkip}
        />
        <ClipPlayer
          label="Response B"
          audioRef={audioBRef}
          src={comparison.clipB.audioUrl}
          error={audioError === "b"}
          onPlay={() => dispatch({ type: "played", clip: "b" })}
          onError={() => dispatch({ type: "audioErrored", clip: "b" })}
          onRetry={() => retryClip("b")}
          onSkip={handleSkip}
        />
      </div>

      <button type="button" onClick={handlePlayBoth} style={secondaryButtonStyle}>
        Play both
      </button>

      <p style={{ fontSize: 12, color: "var(--gray-700)", margin: "12px 0 4px" }}>
        Played: prompt {playCounts.prompt} · A {playCounts.a} · B {playCounts.b}
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0 8px" }}>
        {(["a", "b", "tie", "both_bad"] as const).map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => dispatch({ type: "vote", outcome: o, now: Date.now() })}
            disabled={submitting}
            style={outcome === o ? selectedButtonStyle : buttonStyle}
          >
            {OUTCOME_LABELS[o]}
          </button>
        ))}
      </div>

      {outcome ? (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--gray-alpha-400)" }}>
          <p className="label" style={{ marginBottom: 8 }}>
            What most influenced your choice?
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {VOICE_JUDGMENT_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => dispatch({ type: "setReason", reason: r })}
                disabled={submitting}
                style={reason === r ? selectedButtonStyle : buttonStyle}
              >
                {REASON_LABELS[r]}
              </button>
            ))}
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, marginBottom: 16 }}>
            Anything else? (optional)
            <textarea
              rows={2}
              maxLength={2000}
              value={freeText}
              disabled={submitting}
              onChange={(e) => dispatch({ type: "setFreeText", text: e.target.value })}
              style={textareaStyle}
            />
          </label>

          {submitError ? (
            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: 13, color: "var(--red-700)", marginBottom: 8 }}>{submitError.message}</p>
              <button type="button" onClick={handleRetry} style={primaryButtonStyle}>
                Retry
              </button>
            </div>
          ) : (
            <button type="button" onClick={handleSubmit} disabled={!readyToSubmit || submitting} style={primaryButtonStyle}>
              {submitting ? "Submitting…" : "Submit"}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ClipPlayer({
  label,
  audioRef,
  src,
  error,
  onPlay,
  onEnded,
  onError,
  onRetry,
  onSkip,
}: {
  label: string;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  src: string;
  error: boolean;
  onPlay: () => void;
  onEnded?: () => void;
  onError: () => void;
  onRetry: () => void;
  onSkip: () => void;
}) {
  return (
    <div>
      <p className="label" style={{ marginBottom: 6 }}>
        {label}
      </p>
      <audio
        ref={audioRef}
        controls
        preload="none"
        aria-label={label}
        src={src}
        onPlay={onPlay}
        onEnded={onEnded}
        onError={onError}
        style={{ width: "100%", height: 32 }}
      />
      {error ? (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--red-700)" }}>Couldn&apos;t load this clip.</span>
          <button type="button" onClick={onRetry} style={inlineButtonStyle}>
            Retry
          </button>
          <button type="button" onClick={onSkip} style={inlineButtonStyle}>
            Skip
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PendingPlaceholder() {
  return (
    <div aria-hidden="true">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ ...skeletonStyle, width: 160, height: 22 }} />
        <div style={{ ...skeletonStyle, width: 90, height: 16 }} />
      </div>
      <div style={{ ...skeletonStyle, height: 32, marginBottom: 16 }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 12 }}>
        <div style={{ ...skeletonStyle, height: 32 }} />
        <div style={{ ...skeletonStyle, height: 32 }} />
      </div>
      <div style={{ ...skeletonStyle, width: 100, height: 32 }} />
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--gray-alpha-400)",
  borderRadius: 12,
  padding: 24,
};

const skeletonStyle: React.CSSProperties = {
  borderRadius: 6,
  background: "var(--gray-alpha-200)",
};

const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

const buttonStyle: React.CSSProperties = {
  height: 36,
  padding: "0 14px",
  borderRadius: 6,
  border: "1px solid var(--gray-alpha-400)",
  background: "transparent",
  color: "var(--gray-1000)",
  fontSize: 13,
  cursor: "pointer",
};

const selectedButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "var(--gray-1000)",
  color: "var(--background-100)",
  borderColor: "var(--gray-1000)",
};

const primaryButtonStyle: React.CSSProperties = {
  height: 40,
  padding: "0 20px",
  borderRadius: 6,
  border: "none",
  background: "var(--gray-1000)",
  color: "var(--background-100)",
  fontWeight: 500,
  fontSize: 14,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  height: 32,
  padding: "0 12px",
  borderRadius: 6,
  border: "1px solid var(--gray-alpha-400)",
  background: "transparent",
  color: "var(--gray-1000)",
  fontSize: 13,
  cursor: "pointer",
};

const inlineButtonStyle: React.CSSProperties = {
  height: 24,
  padding: "0 8px",
  borderRadius: 4,
  border: "1px solid var(--gray-alpha-400)",
  background: "transparent",
  color: "var(--gray-1000)",
  fontSize: 12,
  cursor: "pointer",
};

const textareaStyle: React.CSSProperties = {
  padding: 10,
  borderRadius: 6,
  border: "1px solid var(--gray-alpha-400)",
  background: "var(--background-100)",
  color: "var(--gray-1000)",
  resize: "vertical",
  fontFamily: "inherit",
  fontSize: 13,
};
