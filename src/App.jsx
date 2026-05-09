import { useEffect, useMemo, useRef, useState } from "react";

const acceptedGameTypes = ".zip";
const apiBaseUrl = "http://localhost:8787";
const handCameraStreamUrl = `${apiBaseUrl}/api/camera/video`;

const indexGestureOptions = [
  {
    id: "index_extend",
    label: "Index Extend",
    description: "Index finger straight",
    pose: {
      left: { thumb: 0, index: 100, middle: 0, ring: 0, pinky: 0 },
      right: { thumb: 0, index: 100, middle: 0, ring: 0, pinky: 0 },
    },
  },
  {
    id: "index_fold",
    label: "Index Fold",
    description: "Index finger curled",
    pose: {
      left: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
      right: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
    },
  },
];

const fingerControls = [
  { id: "thumb", label: "Thumb" },
  { id: "index", label: "Index" },
  { id: "middle", label: "Middle" },
  { id: "ring", label: "Ring" },
  { id: "pinky", label: "Pinky" },
];

const handPosePresets = {
  open: {
    thumb: 100,
    index: 100,
    middle: 100,
    ring: 100,
    pinky: 100,
  },
  fist: {
    thumb: 0,
    index: 0,
    middle: 0,
    ring: 0,
    pinky: 0,
  },
  peace: {
    thumb: 30,
    index: 100,
    middle: 100,
    ring: 0,
    pinky: 0,
  },
};

const emptyAnalysis = {
  controls: [],
  unresolved: [],
};

function sourceIdentity(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  return [item.file ?? "", item.line ?? "", item.text ?? ""].join("::");
}

function mergeSourceLists(...lists) {
  const seen = new Set();
  const merged = [];

  lists.flat().forEach((item) => {
    const identity = sourceIdentity(item);

    if (!identity || seen.has(identity)) {
      return;
    }

    seen.add(identity);
    merged.push(item);
  });

  return merged;
}

function dedupeAnalysisControls(nextAnalysis) {
  const controls = Array.isArray(nextAnalysis?.controls) ? nextAnalysis.controls : [];
  const mergedControls = [];
  const byKey = new Map();

  controls.forEach((control) => {
    const action = String(control.action ?? control.id ?? "").trim().toLowerCase();
    const key = String(control.key ?? "").trim().toLowerCase();
    const code = String(control.code ?? "").trim().toLowerCase();
    const dedupeKey = `${action}|${key}|${code}`;

    if (!action && !key && !code) {
      mergedControls.push(control);
      return;
    }

    const existing = byKey.get(dedupeKey);

    if (!existing) {
      const copied = {
        ...control,
        usage_targets: mergeSourceLists(control.usage_targets ?? []),
        evidence: mergeSourceLists(control.evidence ?? []),
      };
      byKey.set(dedupeKey, copied);
      mergedControls.push(copied);
      return;
    }

    existing.usage_targets = mergeSourceLists(existing.usage_targets ?? [], control.usage_targets ?? []);
    existing.evidence = mergeSourceLists(existing.evidence ?? [], control.evidence ?? []);
    existing.confidence = Math.max(Number(existing.confidence ?? 0), Number(control.confidence ?? 0));

    if (!existing.binding_target && control.binding_target) {
      existing.binding_target = control.binding_target;
    }
  });

  return {
    ...nextAnalysis,
    controls: mergedControls,
  };
}

function formatFileSize(bytes) {
  if (!bytes) {
    return "0 KB";
  }

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / 1024 ** unitIndex;

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true" />;
}

function UploadIcon() {
  return (
    <span className="upload-icon" aria-hidden="true">
      <span />
    </span>
  );
}

function SettingsGlyph() {
  return (
    <span className="settings-glyph" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

function StepTabs({ currentStep, onStepChange, canOpenStep }) {
  return (
    <nav className="step-tabs" aria-label="Build steps">
      {["Upload Your Game", "Choose The Gesture", "Display"].map((label, index) => {
        const step = index + 1;
        const isDisabled = !canOpenStep(step);

        return (
          <button
            className={`step-tab${currentStep === step ? " is-active" : ""}`}
            disabled={isDisabled}
            key={label}
            type="button"
            onClick={() => onStepChange(step)}
          >
            <span>0{step}</span>
            {label}
          </button>
        );
      })}
    </nav>
  );
}

function PixelHand() {
  return (
    <div className="pixel-hand" aria-hidden="true">
      <span className="finger one" />
      <span className="finger two" />
      <span className="finger three" />
      <span className="finger four" />
      <span className="palm" />
    </div>
  );
}

function GestureRings() {
  return (
    <div className="gesture-rings" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function FingerSlider({ id, label, value, onChange }) {
  const isExtended = value === 100;

  return (
    <div className="finger-control">
      <span>{label}</span>
      <div className="fold-toggle" role="group" aria-label={`${label} state`}>
        <button
          className={!isExtended ? "is-active" : ""}
          type="button"
          onClick={() => onChange(id, 0)}
        >
          Fold
        </button>
        <button
          className={isExtended ? "is-active" : ""}
          type="button"
          onClick={() => onChange(id, 100)}
        >
          Extend
        </button>
      </div>
    </div>
  );
}

function RigHand({ side, pose }) {
  const isFist = Object.values(pose).every((value) => value === 0);
  const foldVars = Object.fromEntries(
    Object.entries(pose).flatMap(([finger, value]) => {
      const fold = 100 - value;
      return [
        [`--${finger}-base-fold`, `${fold * -0.46}deg`],
        [`--${finger}-mid-fold`, `${fold * -0.64}deg`],
        [`--${finger}-tip-fold`, `${fold * -0.56}deg`],
      ];
    }),
  );

  const style = {
    ...foldVars,
  };

  return (
    <div className={`rig-hand ${side}${isFist ? " is-fist" : ""}`} style={style} aria-hidden="true">
      {fingerControls.map((finger) => (
        <span
          className={`rig-finger rig-${finger.id} ${
            pose[finger.id] === 100 ? "is-extended" : "is-folded"
          }`}
          key={finger.id}
        >
          {finger.id === "thumb" ? (
            <span className="finger-segment base">
              <span className="finger-segment tip" />
            </span>
          ) : (
            <span className="finger-segment base">
              <span className="finger-segment mid">
                <span className="finger-segment tip" />
              </span>
            </span>
          )}
        </span>
      ))}
      <span className="rig-palm" />
      <span className="rig-wrist" />
    </div>
  );
}

function HandRig({ pose }) {
  return (
    <div className="hand-rig" aria-label="Gesture hand preview">
      <div className="rig-stage">
        <div className="rig-gridline" />
        <RigHand side="left" pose={pose.left} />
        <RigHand side="right" pose={pose.right} />
      </div>
      <div className="rig-readout">
        <span>Dual Hand Preview</span>
        <span className="mini-led">TRACKING</span>
      </div>
    </div>
  );
}

function UploadPanel({
  selectedFile,
  githubUrl,
  isDragging,
  session,
  sessionStatus,
  errorMessage,
  onGithubUrlChange,
  onFileChange,
  onDrop,
  onDragStateChange,
  onReset,
  onAnalyzeGithub,
  onAnalyzeZip,
  fileInputRef,
}) {
  const inputId = "game-file";
  const helperText = useMemo(() => {
    if (!selectedFile) {
      return "ZIP build or paste a GitHub source URL";
    }

    return `${formatFileSize(selectedFile.size)} ready for backend analysis`;
  }, [selectedFile]);
  const isWorking = ["queued", "cloning", "extracting", "analyzing"].includes(sessionStatus);

  return (
    <section className="upload-panel">
      <p className="eyebrow">Level 01</p>
      <h1 id="page-title">UPLOAD YOUR GAME</h1>
      <p className="intro">
        Drop in a game build and forge every keyboard action into a camera gesture.
      </p>

      <div className="github-entry">
        <span className="file-label">GitHub Source URL</span>
        <input
          placeholder="https://github.com/OWNER/REPO"
          type="url"
          value={githubUrl}
          onChange={(event) => onGithubUrlChange(event.target.value)}
        />
      </div>

      <label
        className={`drop-zone${isDragging ? " is-dragging" : ""}`}
        htmlFor={inputId}
        onDragEnter={(event) => {
          event.preventDefault();
          onDragStateChange(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          onDragStateChange(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          onDragStateChange(false);
        }}
        onDrop={onDrop}
      >
        <input
          id={inputId}
          ref={fileInputRef}
          type="file"
          accept={acceptedGameTypes}
          onChange={onFileChange}
        />
        <UploadIcon />
        <span className="drop-title">{selectedFile ? selectedFile.name : "Choose Game File"}</span>
        <span className="drop-copy">{helperText}</span>
      </label>

      {selectedFile && (
        <div className="file-card">
          <div>
            <span className="file-label">Selected Build</span>
            <strong>{selectedFile.name}</strong>
          </div>
          <button className="pixel-button secondary" type="button" onClick={onReset}>
            Reset
          </button>
        </div>
      )}

      <div className="actions">
        <button
          className="pixel-button"
          disabled={isWorking || !githubUrl.trim()}
          type="button"
          onClick={onAnalyzeGithub}
        >
          Analyze URL
        </button>
        <button
          className="pixel-button secondary"
          disabled={isWorking || !selectedFile}
          type="button"
          onClick={onAnalyzeZip}
        >
          Analyze ZIP
        </button>
        <button className="icon-button" type="button" aria-label="Open settings">
          <SettingsGlyph />
        </button>
      </div>

      {(session || sessionStatus || errorMessage) && (
        <div className="session-card">
          <div className="board-title">
            <span>{session?.session_id ? "Session Ready" : "Session Status"}</span>
            <span className="mini-led">{sessionStatus || "IDLE"}</span>
          </div>
          {session?.session_id && <code>{session.session_id}</code>}
          {isWorking && <p>Backend is preparing the source and extracting keyboard controls.</p>}
          {errorMessage && <p className="error-text">{errorMessage}</p>}
        </div>
      )}
    </section>
  );
}

function ChooseGesturePanel({
  analysis,
  mappings,
  patchReport,
  isPlanningPatch,
  isApplyingPatch,
  patchApplyError,
  onMappingChange,
  onBack,
  onPlan,
  onApplyPlan,
  onDisplay,
}) {
  const controls = analysis?.controls ?? [];
  const previewGesture = indexGestureOptions.find((option) => option.id === Object.values(mappings)[0]);
  const previewPose = previewGesture?.pose ?? indexGestureOptions[0].pose;
  const patchStatus = patchReport?.status;
  const plannedPatches = patchReport?.patches?.length ?? 0;
  const runtimeInjections = patchReport?.runtime_injections?.length ?? 0;
  const manualReviewCount = patchReport?.manual_review?.length ?? 0;
  const canApplyPlan = plannedPatches > 0 || runtimeInjections > 0;
  const gestureConflicts = indexGestureOptions
    .map((gesture) => ({
      gesture,
      controls: controls.filter((control) => mappings[control.id] === gesture.id),
    }))
    .filter((group) => group.controls.length > 1);

  return (
    <section className="stage-panel gesture-stage">
      <p className="eyebrow">Level 02</p>
      <h1 id="page-title">CHOOSE THE GESTURE</h1>
      <p className="intro">
        Assign each detected keyboard control to an index finger gesture.
      </p>

      <div className="mapping-workbench">
        <div className="control-list" aria-label="Detected keyboard controls">
          <div className="board-title">
            <span>Detected Controls</span>
            <span className="mini-led">{controls.length} FOUND</span>
          </div>
          {controls.map((control, index) => {
            const selectedGesture = mappings[control.id] ?? indexGestureOptions[index % indexGestureOptions.length].id;

            return (
              <div className="control-map-row" key={control.id}>
                <div>
                  <strong>{control.action}</strong>
                  <span>
                    {control.key} / {control.code}
                  </span>
                </div>
                <div className="gesture-choice" role="group" aria-label={`${control.action} gesture`}>
                  {indexGestureOptions.map((option) => (
                    <button
                      className={selectedGesture === option.id ? "is-active" : ""}
                      key={option.id}
                      type="button"
                      onClick={() => onMappingChange(control.id, option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {!controls.length && (
            <div className="empty-state">
              <strong>No controls detected</strong>
              <span>Run backend analysis before mapping gestures.</span>
            </div>
          )}
        </div>

        <HandRig pose={previewPose} />
      </div>

      <div className="actions">
        <button className="pixel-button secondary" type="button" onClick={onBack}>
          Back
        </button>
        <button className="pixel-button secondary" disabled={!controls.length || isPlanningPatch} type="button" onClick={onPlan}>
          {isPlanningPatch ? "Planning" : patchStatus === "planned" ? "Update Plan" : "Create Plan"}
        </button>
        {patchStatus === "planned" ? (
          <button className="pixel-button" disabled={isApplyingPatch || !canApplyPlan} type="button" onClick={onApplyPlan}>
            {isApplyingPatch ? "Applying" : "Apply Plan"}
          </button>
        ) : null}
        {patchStatus === "patched" ? (
          <button className="pixel-button" type="button" onClick={onDisplay}>
            Display
          </button>
        ) : null}
      </div>

      {gestureConflicts.length > 0 && (
        <div className="gesture-plan-card is-warning">
          <div className="board-title">
            <span>Gesture Conflict</span>
            <span className="mini-led">CHECK</span>
          </div>
          {gestureConflicts.map((group) => (
            <p className="patch-note" key={group.gesture.id}>
              {group.gesture.label}: {group.controls.map((control) => control.action).join(" + ")}
            </p>
          ))}
        </div>
      )}

      {(patchReport || patchApplyError) && (
        <div className="gesture-plan-card">
          <div className="board-title">
            <span>Patch Plan</span>
            <span className="mini-led">{patchStatus === "patched" ? "APPLIED" : patchStatus === "planned" ? "READY" : "CHECK"}</span>
          </div>
          {patchStatus === "planned" && (
            <p className="patch-note">
              {plannedPatches} line changes ready, {runtimeInjections} runtime injection{runtimeInjections === 1 ? "" : "s"}
              {manualReviewCount ? `, ${manualReviewCount} need review` : ""}.
            </p>
          )}
          {patchStatus === "patched" && <p className="patch-note">Patched game is ready for display.</p>}
          {patchStatus === "plan_failed" && <p className="patch-note">{patchReport.error || "Plan failed."}</p>}
          {patchApplyError && <p className="patch-note">{patchApplyError}</p>}
        </div>
      )}
    </section>
  );
}

function CameraPreview() {
  const [streamReady, setStreamReady] = useState(false);
  const [streamUrl, setStreamUrl] = useState("");
  const [cameraStatus, setCameraStatus] = useState("STARTING CAMERA");

  useEffect(() => {
    let isMounted = true;
    let retryTimer;

    async function startCamera() {
      try {
        setCameraStatus("STARTING CAMERA");
        const response = await fetch(`${apiBaseUrl}/api/camera/start`);
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || "Camera failed to start.");
        }

        if (isMounted) {
          setCameraStatus("CAMERA STREAM");
          setStreamUrl(`${handCameraStreamUrl}?t=${Date.now()}`);
        }
      } catch (error) {
        if (isMounted) {
          setStreamReady(false);
          setCameraStatus(error.message);
          retryTimer = window.setTimeout(startCamera, 2500);
        }
      }
    }

    startCamera();

    return () => {
      isMounted = false;

      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  return (
    <div className="camera-preview">
      {streamUrl && (
        <img
          alt="Live hand skeleton"
          src={streamUrl}
          onLoad={() => setStreamReady(true)}
          onError={() => {
            setStreamReady(false);
            setCameraStatus("CAMERA RETRY");
            setStreamUrl(`${handCameraStreamUrl}?t=${Date.now()}`);
          }}
        />
      )}
      <div className="camera-hud">
        <span className="status-light" aria-hidden="true" />
        {streamReady ? "CAMERA ON / INDEX STATE" : cameraStatus}
      </div>
    </div>
  );
}

function DisplayPanel({
  mappings,
  analysis,
  session,
  patchReport,
  onBack,
  onRestart,
}) {
  const gameFrameRef = useRef(null);
  const controls = analysis?.controls ?? [];
  const gameUrl = session?.game_url ? `${apiBaseUrl}${session.game_url}` : "";
  const patchStatus = patchReport?.status;

  useEffect(() => {
    let isMounted = true;
    let timer;

    async function pollGestureState() {
      try {
        const response = await fetch(`${apiBaseUrl}/api/camera/state`, { cache: "no-store" });
        const state = await response.json();
        const target = gameFrameRef.current?.contentWindow;

        if (target?.gestureForge?.setState) {
          target.gestureForge.setState({
            indexExtended: Boolean(state.indexExtended),
            indexFolded: Boolean(state.indexFolded),
          });
        }
      } catch {
      } finally {
        if (isMounted) {
          timer = window.setTimeout(pollGestureState, 80);
        }
      }
    }

    pollGestureState();

    return () => {
      isMounted = false;

      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  return (
    <section className="play-mode" aria-label="GestureForge play mode">
      {gameUrl ? (
        <iframe ref={gameFrameRef} className="play-game-frame" src={gameUrl} title="Session game display" />
      ) : (
        <div className="play-fallback" aria-hidden="true">
          <span className="hero-sprite" />
          <span className="platform one" />
          <span className="platform two" />
        </div>
      )}

      <CameraPreview />

      <div className="play-map-overlay" aria-label="Active gesture mappings">
        <div className="board-title">
          <span>Index Map</span>
          <span className="mini-led">{patchStatus === "planned" ? "REVIEW" : patchStatus === "patched" ? "PATCHED" : "LIVE"}</span>
        </div>
        {patchStatus === "patched" && <p className="patch-note">Patched game is running.</p>}
        {patchStatus === "plan_failed" && <p className="patch-note">Plan failed. Showing original game.</p>}
        <div className="play-map-list">
          {controls.map((control) => {
            const gestureId = mappings[control.id];
            const gesture = indexGestureOptions.find((option) => option.id === gestureId);

            return (
              <div className="play-map-row" key={control.id}>
                <span>{control.action}</span>
                <kbd>{gesture?.label ?? "Unmapped"}</kbd>
              </div>
            );
          })}
          {!controls.length && (
            <div className="play-map-row">
              <span>No controls</span>
              <kbd>--</kbd>
            </div>
          )}
        </div>
      </div>

      <div className="play-actions">
        <button className="pixel-button secondary" type="button" onClick={onBack}>
          Map
        </button>
        <button className="pixel-button" type="button" onClick={onRestart}>
          New Game
        </button>
      </div>
    </section>
  );
}

function GesturePreview({ mappings, analysis }) {
  const controls = analysis?.controls ?? [];

  return (
    <aside className="preview-panel" aria-label="Gesture control preview">
      <div className="arcade-frame">
        <div className="scanline" />
        <PixelHand />
        <GestureRings />
      </div>

      <div className="mapping-board">
        <div className="board-title">
          <span>Gesture Map</span>
          <span className="mini-led">LIVE</span>
        </div>
        {controls.slice(0, 4).map((control) => {
          const gesture = indexGestureOptions.find((option) => option.id === mappings[control.id]);

          return (
            <div className="mapping-row" key={control.id}>
              <span>{control.action}</span>
              <kbd>{gesture?.label ?? control.key}</kbd>
            </div>
          );
        })}
        {!controls.length && (
          <div className="mapping-row">
            <span>Index Extend</span>
            <kbd>Ready</kbd>
          </div>
        )}
      </div>
    </aside>
  );
}

export default function App() {
  const fileInputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [analysis, setAnalysis] = useState(emptyAnalysis);
  const [session, setSession] = useState(null);
  const [sessionStatus, setSessionStatus] = useState("");
  const [mappings, setMappings] = useState({});
  const [errorMessage, setErrorMessage] = useState("");
  const [patchReport, setPatchReport] = useState(null);
  const [isPlanningPatch, setIsPlanningPatch] = useState(false);
  const [isApplyingPatch, setIsApplyingPatch] = useState(false);
  const [patchApplyError, setPatchApplyError] = useState("");

  function applyAnalysis(nextSession, nextAnalysis) {
    const dedupedAnalysis = dedupeAnalysisControls(nextAnalysis);
    const nextMappings = Object.fromEntries(
      (dedupedAnalysis.controls ?? []).map((control, index) => [
        control.id,
        indexGestureOptions[index % indexGestureOptions.length].id,
      ]),
    );

    setSession(nextSession);
    setAnalysis(dedupedAnalysis);
    setMappings(nextMappings);
    setPatchReport(null);
    setPatchApplyError("");
    setCurrentStep(2);
  }

  async function pollSession(sessionId) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 240000) {
      const statusResponse = await fetch(`${apiBaseUrl}/api/sessions/${sessionId}`);
      const statusPayload = await statusResponse.json();
      setSessionStatus(statusPayload.status);

      if (statusPayload.status === "failed") {
        throw new Error(statusPayload.hint || statusPayload.error || "Session analysis failed.");
      }

      if (statusPayload.status === "ready") {
        const analysisResponse = await fetch(`${apiBaseUrl}/api/sessions/${sessionId}/analysis`);
        const nextAnalysis = await analysisResponse.json();
        applyAnalysis(statusPayload, nextAnalysis);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2200));
    }

    throw new Error("Backend analysis timed out.");
  }

  async function createGithubSession() {
    setErrorMessage("");
    setSessionStatus("queued");

    try {
      const response = await fetch(`${apiBaseUrl}/api/sessions/github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ github_url: githubUrl.trim() }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not create GitHub session.");
      }

      setSession(payload);
      await pollSession(payload.session_id);
    } catch (error) {
      setSessionStatus("failed");
      setErrorMessage(error.message);
    }
  }

  async function createZipSession() {
    if (!selectedFile) {
      return;
    }

    setErrorMessage("");
    setSessionStatus("queued");

    try {
      const response = await fetch(`${apiBaseUrl}/api/sessions/zip`, {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "X-Filename": selectedFile.name,
        },
        body: selectedFile,
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not create ZIP session.");
      }

      setSession(payload);
      await pollSession(payload.session_id);
    } catch (error) {
      setSessionStatus("failed");
      setErrorMessage(error.message);
    }
  }

  async function saveMappingAndPlan() {
    if (!session?.session_id) {
      return;
    }

    const payload = {
      session_id: session.session_id,
      version: 1,
      controls: (analysis.controls ?? []).map((control) => {
        const gestureId = mappings[control.id];
        const gesture = indexGestureOptions.find((option) => option.id === gestureId);

        return {
          control_id: control.id,
          key: control.key,
          code: control.code,
          action: control.action,
          gesture: gesture?.id ?? gestureId,
          gesture_label: gesture?.label ?? gestureId,
          suggested_function: control.suggested_function,
          binding_target: control.binding_target,
          usage_targets: control.usage_targets ?? [],
        };
      }),
    };

    setErrorMessage("");
    setPatchApplyError("");
    setIsPlanningPatch(true);

    try {
      const response = await fetch(`${apiBaseUrl}/api/sessions/${session.session_id}/mapping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorPayload = await response.json();
        throw new Error(errorPayload.error || "Could not save mapping.");
      }

      const patchResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.session_id}/plan-mapping`, {
        method: "POST",
      });
      const patchPayload = await patchResponse.json();

      setPatchReport(
        patchResponse.ok
          ? patchPayload.plan
          : {
              status: "plan_failed",
              error: patchPayload.error || "Could not plan game control changes.",
              patches: [],
            },
      );
      setSession((currentSession) => ({
        ...currentSession,
        game_url: patchPayload.game_url ?? currentSession?.game_url,
      }));
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsPlanningPatch(false);
    }
  }

  async function applyConfirmedPatchPlan() {
    if (!session?.session_id) {
      return;
    }

    setIsApplyingPatch(true);
    setPatchApplyError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/sessions/${session.session_id}/apply-mapping`, {
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not apply patch plan.");
      }

      setPatchReport(payload.report);
      setSession((currentSession) => ({
        ...currentSession,
        game_url: `${payload.game_url ?? currentSession?.game_url}?patched=${Date.now()}`,
      }));
      setCurrentStep(3);
    } catch (error) {
      setPatchApplyError(error.message);
    } finally {
      setIsApplyingPatch(false);
    }
  }

  function updateSelectedFile(file) {
    setSelectedFile(file ?? null);
  }

  function handleFileChange(event) {
    updateSelectedFile(event.target.files?.[0]);
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    updateSelectedFile(event.dataTransfer.files?.[0]);
  }

  function handleReset() {
    updateSelectedFile(null);
    setGithubUrl("");
    setAnalysis(emptyAnalysis);
    setSession(null);
    setSessionStatus("");
    setMappings({});
    setPatchReport(null);
    setIsApplyingPatch(false);
    setPatchApplyError("");
    setErrorMessage("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleRestart() {
    handleReset();
    setCurrentStep(1);
  }

  function updateMapping(controlId, gestureId) {
    setMappings((currentMappings) => ({
      ...currentMappings,
      [controlId]: gestureId,
    }));
    setPatchReport(null);
    setPatchApplyError("");
  }

  function canOpenStep(step) {
    if (step === 1) {
      return true;
    }

    if (step === 2) {
      return Boolean(analysis.controls?.length);
    }

    return Boolean(session?.session_id && analysis.controls?.length && patchReport?.status === "patched");
  }

  function renderStep() {
    if (currentStep === 2) {
      return (
        <ChooseGesturePanel
          analysis={analysis}
          isApplyingPatch={isApplyingPatch}
          isPlanningPatch={isPlanningPatch}
          mappings={mappings}
          onMappingChange={updateMapping}
          onApplyPlan={applyConfirmedPatchPlan}
          onBack={() => setCurrentStep(1)}
          onDisplay={() => setCurrentStep(3)}
          onPlan={saveMappingAndPlan}
          patchApplyError={patchApplyError}
          patchReport={patchReport}
        />
      );
    }

    if (currentStep === 3) {
      return (
        <DisplayPanel
          analysis={analysis}
          mappings={mappings}
          patchReport={patchReport}
          session={session}
          onBack={() => setCurrentStep(2)}
          onRestart={handleRestart}
        />
      );
    }

    return (
      <UploadPanel
        selectedFile={selectedFile}
        githubUrl={githubUrl}
        isDragging={isDragging}
        session={session}
        sessionStatus={sessionStatus}
        errorMessage={errorMessage}
        onGithubUrlChange={setGithubUrl}
        onFileChange={handleFileChange}
        onDrop={handleDrop}
        onDragStateChange={setIsDragging}
        onReset={handleReset}
        onAnalyzeGithub={createGithubSession}
        onAnalyzeZip={createZipSession}
        fileInputRef={fileInputRef}
      />
    );
  }

  if (currentStep === 3) {
    return renderStep();
  }

  return (
    <main className="app-shell">
      <section className="screen" aria-labelledby="page-title">
        <div className="top-bar">
          <div className="brand">
            <BrandMark />
            <span>GestureForge</span>
          </div>
          <div className="status-chip">
            <span className="status-light" aria-hidden="true" />
            Gesture Engine Ready
          </div>
        </div>

        <StepTabs currentStep={currentStep} onStepChange={setCurrentStep} canOpenStep={canOpenStep} />

        <div className={`hero-grid${currentStep === 2 ? " gesture-editor-grid" : ""}`}>
          {renderStep()}
          {currentStep !== 2 && <GesturePreview analysis={analysis} mappings={mappings} />}
        </div>
      </section>
    </main>
  );
}
