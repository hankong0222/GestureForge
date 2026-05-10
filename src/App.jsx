import { useEffect, useMemo, useRef, useState } from "react";

const acceptedGameTypes = ".zip";
const apiBaseUrl = "http://localhost:8787";
const handCameraStreamUrl = `${apiBaseUrl}/api/camera/video`;
const companyGumImageAsset = "Caffeinated Chewing Gum.png";
const fakeGeneratedImageUrl = `${apiBaseUrl}/api/assets/${encodeURIComponent(companyGumImageAsset)}`;
const companyAdVideoAsset = "Caffeinated Chewing Gum.mp4";
const savedStateKey = "gestureforge.uiState.v1";
const recordingMimeTypes = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];
const cloudinaryCloudName = (import.meta.env.VITE_CLOUDINARY_CLOUD_NAME ?? "").trim();
const cloudinaryUploadPreset = (import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET ?? "").trim();
const cloudinaryUploadFolder = (import.meta.env.VITE_CLOUDINARY_FOLDER ?? "").trim();

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

const companyPalettes = [
  {
    name: "Signal Pop",
    colors: ["#101827", "#5de6ff", "#ffd65a", "#ff5f9f"],
    accent: "high-contrast cyan, warm yellow, sharp pink",
  },
  {
    name: "Fresh Utility",
    colors: ["#10231e", "#92ff73", "#5de6ff", "#f6f1df"],
    accent: "fresh green, clean cyan, soft cream",
  },
  {
    name: "Premium Pulse",
    colors: ["#160f24", "#ff5f9f", "#ffd65a", "#f6f1df"],
    accent: "deep violet, vivid pink, premium gold",
  },
  {
    name: "Calm Tech",
    colors: ["#0d1830", "#5de6ff", "#92ff73", "#aeb7c2"],
    accent: "electric blue, health green, cool gray",
  },
];

const mockupFormats = [
  { id: "box", label: "Box" },
  { id: "bottle", label: "Bottle" },
  { id: "pouch", label: "Pouch" },
];

function normalizeFingerCombo(fingers) {
  const selected = new Set(Array.isArray(fingers) ? fingers : []);
  return fingerControls.map((finger) => finger.id).filter((finger) => selected.has(finger));
}

function fingerComboKey(fingers) {
  return normalizeFingerCombo(fingers).join("|");
}

function fingerComboLabel(fingers) {
  const combo = normalizeFingerCombo(fingers);

  if (!combo.length) {
    return "No Fingers";
  }

  return combo
    .map((fingerId) => fingerControls.find((finger) => finger.id === fingerId)?.label ?? fingerId)
    .join(" + ");
}

function poseFromFingers(fingers) {
  const combo = new Set(normalizeFingerCombo(fingers));
  const pose = Object.fromEntries(fingerControls.map((finger) => [finger.id, combo.has(finger.id) ? 100 : 0]));

  return {
    left: pose,
    right: pose,
  };
}

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

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function supportedRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }

  return recordingMimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function cloudinaryStatusLabel(status) {
  const labels = {
    idle: "LOCAL",
    unconfigured: "CONFIG",
    uploading: "UPLOADING",
    registering: "SYNCING",
    stored: "STORED",
    failed: "FAILED",
    backend_failed: "BACKEND",
  };

  return labels[status] ?? "LOCAL";
}

function videoAnalysisStatusLabel(status) {
  const labels = {
    idle: "IDLE",
    queued: "QUEUED",
    analyzing: "ANALYZING",
    partial: "PARTIAL",
    complete: "READY",
    failed: "FAILED",
  };

  return labels[status] ?? "IDLE";
}

function clipPlanStatusLabel(status) {
  const labels = {
    idle: "IDLE",
    loading: "LOADING",
    planning: "AI PLAN",
    planned: "PLANNED",
    stale: "STALE",
    failed: "FAILED",
  };

  return labels[status] ?? "IDLE";
}

function clipRenderStatusLabel(status) {
  const labels = {
    idle: "IDLE",
    loading: "LOADING",
    rendering: "RENDERING",
    syncing_assets: "ASSETS",
    rendering_clips: "CLIPS",
    preparing_ad: "AD SLOT",
    splicing: "SPLICING",
    rendered: "READY",
    stale: "STALE",
    failed: "FAILED",
  };

  return labels[status] ?? "IDLE";
}

function isClipRenderActive(status) {
  return ["rendering", "syncing_assets", "rendering_clips", "preparing_ad", "splicing"].includes(status);
}

function workflowState(done, active, failed) {
  if (failed) {
    return "failed";
  }

  if (done) {
    return "done";
  }

  if (active) {
    return "active";
  }

  return "waiting";
}

function workflowStateLabel(state) {
  const labels = {
    active: "RUNNING",
    done: "DONE",
    failed: "FAILED",
    waiting: "WAITING",
  };

  return labels[state] ?? "WAITING";
}

function formatSeconds(seconds) {
  return formatDuration(Number(seconds || 0) * 1000);
}

function cloneClipPlan(plan) {
  if (!plan) {
    return null;
  }

  return JSON.parse(JSON.stringify(plan));
}

function clipTitleText(clip) {
  return clip?.overlays?.find((overlay) => overlay?.type === "text" && overlay.role === "meme_title")?.text
    || clip?.source_highlight?.title
    || clip?.id
    || "Funny Moment";
}

function clipPlanDetailItems(clip) {
  const notes = clip?.edit_notes && typeof clip.edit_notes === "object" ? clip.edit_notes : {};
  const assetRationale = notes.asset_rationale && typeof notes.asset_rationale === "object" ? notes.asset_rationale : {};
  const items = [
    ["Hook", notes.hook],
    ["Setup", notes.setup],
    ["Payoff", notes.payoff],
    ["Why", notes.why_funny || clip?.source_highlight?.reason],
    ["Timing", notes.timing_notes],
    ["Visual", notes.visual_strategy],
    ["Audio", notes.audio_strategy],
    ["Meme", assetRationale.meme],
    ["Sound", assetRationale.sound],
    ["Tune", notes.manual_tune_hint],
    ["Risk", notes.risk_notes],
  ];

  return items
    .map(([label, value]) => [label, String(value ?? "").trim()])
    .filter(([, value]) => value);
}

function roleLabel(role) {
  const labels = {
    entrepreneur: "Entrepreneur",
    player: "Player",
  };

  return labels[role] ?? "Player";
}

function titleCaseWords(value) {
  return String(value ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function compactIdeaTitle(productIdea) {
  const trimmed = String(productIdea ?? "").trim();

  if (!trimmed) {
    return "Launch Concept";
  }

  const words = trimmed.split(/\s+/).filter(Boolean);

  if (words.length > 1) {
    return titleCaseWords(words.slice(0, 4).join(" "));
  }

  return trimmed.length > 16 ? `${trimmed.slice(0, 16)}...` : titleCaseWords(trimmed);
}

function pickCompanyPalette(companyName, productIdea) {
  const seedText = `${companyName} ${productIdea}`;
  const seed = Array.from(seedText).reduce((total, character) => total + character.charCodeAt(0), 0);

  return companyPalettes[seed % companyPalettes.length];
}

function voiceScriptText(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => String(segment.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildCompanyAdPlan(companyName, productIdea, ragContext = "") {
  const brandName = String(companyName ?? "").trim() || "Your Company";
  const idea = String(productIdea ?? "").trim() || "a new product idea";
  const productName = compactIdeaTitle(idea);
  const palette = pickCompanyPalette(brandName, idea);
  const context = String(ragContext ?? "").trim();
  const lowerIdea = idea.toLowerCase();
  const benefit = lowerIdea.includes("ai") || lowerIdea.includes("smart")
    ? "turns complex decisions into one confident action"
    : lowerIdea.includes("drink") || lowerIdea.includes("food") || lowerIdea.includes("health")
      ? "makes daily routines feel healthier and easier to keep"
      : "makes the first try feel useful, fast, and memorable";
  const audience = lowerIdea.includes("student")
    ? "students and early-career builders who need clear wins without extra setup"
    : lowerIdea.includes("fitness") || lowerIdea.includes("health")
      ? "health-focused buyers who want progress they can see and repeat"
      : "busy modern customers who reward products that explain themselves quickly";

  return {
    brandName,
    productName,
    idea,
    ragContext: context,
    palette,
    dna: {
      positioning: `${brandName} launches ${productName} as a product that ${benefit}.`,
      audience,
      visualLanguage: `${palette.name}: ${palette.accent}. Large product silhouette, crisp labels, one memorable motion cue.`,
      proofPoint: context
        ? `Use the RAG notes as grounding: ${context.slice(0, 160)}${context.length > 160 ? "..." : ""}`
        : "Show a concrete before-and-after moment within the first five seconds.",
      strategy: "Lead with the product value, show one use moment, close on a single CTA.",
    },
    image: {
      prompt: `Create a premium product ad image for ${brandName}'s ${productName}. Show the product clearly, use ${palette.accent}, include one clean benefit cue, cinematic lighting, mobile ad composition.`,
      negativePrompt: "No clutter, no tiny unreadable text, no generic stock-photo people, no distorted logos.",
      status: "Ready to send to Backboard image generation",
    },
    script: {
      segments: [
        { start: 0, end: 2, text: `Meet ${productName}, built for the moment you need momentum.` },
        { start: 2, end: 5, text: `${brandName} makes the core benefit simple, visible, and easy to trust.` },
        { start: 5, end: 8, text: benefit.charAt(0).toUpperCase() + benefit.slice(1) + ", with a result you can feel quickly." },
        { start: 8, end: 10, text: `Try it today and make the next move easier.` },
      ],
      note: "Keep the final voiceover between 7 and 10 seconds, around 22-30 words.",
      timing: "0-2s hook, 2-7s product proof, 7-10s CTA.",
      audio_status: "idle",
      audio_url: "",
      audio_error: "",
    },
      video: {
        prompt: `Generate a 10-second vertical product ad video for ${productName}. Start with a sharp product reveal, cut to one use moment, end with ${brandName} logo and CTA. Match the generated image style.`,
        storyboard: "0-2s product reveal / 2-5s use moment / 5-8s benefit proof / 8-10s logo and CTA",
        status: "Ready to send to Backboard video generation",
    },
    rag: {
      sources: context || "No RAG source added yet.",
      revisionInstruction: "Apply edits to the current stage while preserving the product DNA and 7-10 second voiceover length.",
    },
  };
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

function RecordGlyph() {
  return <span className="record-glyph" aria-hidden="true" />;
}

function AuthGate({ onAuthenticate }) {
  const emailInputRef = useRef(null);
  const passwordInputRef = useRef(null);
  const [role, setRole] = useState("entrepreneur");
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [needsVerification, setNeedsVerification] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [authError, setAuthError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    function clearLoginFields() {
      setEmail("");
      setPassword("");
      if (emailInputRef.current) {
        emailInputRef.current.value = "";
      }
      if (passwordInputRef.current) {
        passwordInputRef.current.value = "";
      }
    }

    clearLoginFields();
    const autofillTimers = [50, 250, 1000].map((delay) => window.setTimeout(clearLoginFields, delay));

    return () => autofillTimers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  async function submitAuth(event) {
    event.preventDefault();
    setAuthError("");
    setAuthNotice("");
    setIsSubmitting(true);

    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/${mode === "signup" ? "signup" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          name: name.trim(),
          email: email.trim(),
          password,
          verification_code: needsVerification ? verificationCode.trim() : undefined,
        }),
      });
      const payload = await response.json();

      if (response.status === 202 && payload.status === "verification_required") {
        setNeedsVerification(true);
        setAuthNotice(
          payload.email_status === "sent"
            ? "Verification code sent. Check your email."
            : `Email not sent: ${payload.email_error || "Pingram is not configured."}${payload.dev_verification_code ? ` Code: ${payload.dev_verification_code}` : ""}`,
        );
        return;
      }

      if (!response.ok) {
        throw new Error(payload.error || "Authentication failed.");
      }

      setEmail("");
      setPassword("");
      setVerificationCode("");
      onAuthenticate({
        ...payload.user,
        role: payload.user?.role ?? role,
        signedInAt: new Date().toISOString(),
      });
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-brand">
          <BrandMark />
          <span>GestureForge</span>
        </div>
        <p className="eyebrow">Welcome</p>
        <h1 id="auth-title">{mode === "login" ? "LOGIN" : "SIGN UP"}</h1>
        <p className="intro">
          Choose your workspace before starting.
        </p>

        <div className="role-switch" role="group" aria-label="Account type">
          <button className={role === "entrepreneur" ? "is-active" : ""} type="button" onClick={() => setRole("entrepreneur")}>
            Entrepreneur
          </button>
          <button className={role === "player" ? "is-active" : ""} type="button" onClick={() => setRole("player")}>
            Player
          </button>
        </div>

        <form autoComplete="off" className="auth-form" onSubmit={submitAuth}>
          {mode === "signup" && (
            <label>
              <span>Name</span>
              <input autoComplete="off" name="gestureforge-display-name" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          )}
          <label>
            <span>Email</span>
            <input
              ref={emailInputRef}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              name="gestureforge-workspace-email"
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              ref={passwordInputRef}
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              name="gestureforge-workspace-passcode"
              required
              minLength={4}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {mode === "signup" && needsVerification && (
            <label>
              <span>Verification Code</span>
              <input autoComplete="one-time-code" required value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} />
            </label>
          )}
          {authNotice && <p className="auth-notice">{authNotice}</p>}
          {authError && <p className="auth-error">{authError}</p>}
          <button className="pixel-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Please Wait" : mode === "login" ? "Login" : needsVerification ? "Verify & Create" : "Send Code"}
          </button>
        </form>

        <button
          className="auth-toggle"
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setNeedsVerification(false);
            setVerificationCode("");
            setAuthError("");
            setAuthNotice("");
          }}
        >
          {mode === "login" ? "Need an account? Sign up" : "Already have an account? Login"}
        </button>
      </section>
    </main>
  );
}

function StepTabs({ currentStep, onStepChange, canOpenStep }) {
  const steps = ["Upload Your Game", "Choose The Gesture", "Display", "Recording Preview"];

  return (
    <nav className="step-tabs" aria-label="Build steps">
      {steps.map((label, index) => {
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

function RecordingControl({
  recordedClip,
  recordingError,
  recordingStatus,
  onPreviewRecording,
  onStartRecording,
  onStopRecording,
}) {
  const hasRecording = Boolean(recordedClip?.url);
  const isRecording = recordingStatus === "recording";
  const isRecordingBusy = recordingStatus === "starting" || recordingStatus === "stopping";
  const recordingLabel = isRecording
    ? "Recording"
    : recordingStatus === "starting"
      ? "Starting"
      : recordingStatus === "stopping"
        ? "Ending"
        : hasRecording
          ? "Clip Ready"
          : "Screen Record";

  return (
    <div className={`recording-control${isRecording ? " is-recording" : ""}`} aria-label="Screen recording controls">
      <div className="recording-status">
        <span className="recording-dot" aria-hidden="true" />
        <span>{recordingLabel}</span>
      </div>
      <div className="recording-buttons">
        {isRecording ? (
          <button className="pixel-button danger compact" type="button" onClick={onStopRecording}>
            End
          </button>
        ) : (
          <button
            className="pixel-button compact"
            disabled={isRecordingBusy}
            type="button"
            onClick={onStartRecording}
          >
            <RecordGlyph />
            Rec
          </button>
        )}
        {!isRecording ? (
          <button className="pixel-button secondary compact" type="button" onClick={onPreviewRecording}>
            {hasRecording ? "Preview" : "Cuts"}
          </button>
        ) : null}
      </div>
      {recordingError && <p className="recording-error">{recordingError}</p>}
    </div>
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
          {sessionStatus === "cloning" && <p>Backend is cloning the GitHub source.</p>}
          {sessionStatus === "cloned" && <p>Source cloned. Analyzer is starting.</p>}
          {sessionStatus === "analyzing" && session?.cloned_at && <p>Source cloned. Analyzer is extracting keyboard controls.</p>}
          {sessionStatus === "analyzing" && session?.analysis_stage?.stage && (
            <p>Analyzer stage: <code>{session.analysis_stage.stage}</code></p>
          )}
          {isWorking && sessionStatus !== "cloning" && sessionStatus !== "cloned" && !(sessionStatus === "analyzing" && session?.cloned_at) && (
            <p>Backend is preparing the source and extracting keyboard controls.</p>
          )}
          {errorMessage && <p className="error-text">{errorMessage}</p>}
        </div>
      )}
    </section>
  );
}

function ChooseGesturePanel({
  analysis,
  mappings,
  draftMappings,
  selectedControlId,
  conflictPulse,
  patchReport,
  isPlanningPatch,
  isApplyingPatch,
  patchApplyError,
  onDraftMappingChange,
  onConfirmMapping,
  onSelectControl,
  onBack,
  onPlan,
  onApplyPlan,
  onDisplay,
}) {
  const controls = analysis?.controls ?? [];
  const selectedControl = controls.find((control) => control.id === selectedControlId) ?? controls[0];
  const activeControlId = selectedControl?.id;
  const activeDraft = draftMappings[activeControlId] ?? [];
  const previewPose = poseFromFingers(activeDraft);
  const patchStatus = patchReport?.status;
  const plannedPatches = patchReport?.patches?.length ?? 0;
  const runtimeInjections = patchReport?.runtime_injections?.length ?? 0;
  const manualReviewCount = patchReport?.manual_review?.length ?? 0;
  const canApplyPlan = plannedPatches > 0 || runtimeInjections > 0;
  const allConfirmed = controls.length > 0 && controls.every((control) => Array.isArray(mappings[control.id]));

  function toggleFinger(fingerId) {
    if (!activeControlId) {
      return;
    }

    const current = draftMappings[activeControlId] ?? [];
    const next = current.includes(fingerId)
      ? current.filter((item) => item !== fingerId)
      : [...current, fingerId];
    onDraftMappingChange(activeControlId, normalizeFingerCombo(next));
  }

  return (
    <section className={`stage-panel gesture-stage${conflictPulse ? " is-shaking" : ""}`}>
      <p className="eyebrow">Level 02</p>
      <h1 id="page-title">CHOOSE THE GESTURE</h1>
      <p className="intro">
        Pick one or more extended fingers for each action. Empty means every finger is folded.
      </p>

      <div className="mapping-workbench">
        <div className="finger-picker" aria-label="Finger extension reference">
          <div className="board-title">
            <span>{selectedControl ? selectedControl.action : "Finger Extend"}</span>
            <span className="mini-led">{fingerComboLabel(activeDraft)}</span>
          </div>
          <div className="finger-reference" role="group" aria-label="Selected action fingers">
            {fingerControls.map((finger) => (
              <button
                className={`finger-reference-row${activeDraft.includes(finger.id) ? " is-active" : ""}`}
                disabled={!selectedControl}
                key={finger.id}
                type="button"
                onClick={() => toggleFinger(finger.id)}
              >
                <span>{finger.label}</span>
                <kbd>Extend</kbd>
              </button>
            ))}
            <button
              className={`finger-reference-row${activeDraft.length === 0 ? " is-active" : ""}`}
              disabled={!selectedControl}
              type="button"
              onClick={() => activeControlId && onDraftMappingChange(activeControlId, [])}
            >
              <span>None</span>
              <kbd>All Fold</kbd>
            </button>
          </div>
          <button
            className="pixel-button finger-confirm"
            disabled={!selectedControl}
            type="button"
            onClick={() => activeControlId && onConfirmMapping(activeControlId)}
          >
            Confirm
          </button>
        </div>

        <HandRig pose={previewPose} />
      </div>

      <div className="action-setup-board" aria-label="Detected keyboard controls">
        <div className="board-title">
          <span>Action Setup</span>
          <span className="mini-led">{controls.length} FOUND</span>
        </div>
        <div className="action-setup-list">
          {controls.map((control) => {
            const draft = draftMappings[control.id] ?? [];
            const confirmed = Array.isArray(mappings[control.id]);
            const isSelected = control.id === activeControlId;

            return (
              <button
                className={`action-setup-card${confirmed ? " is-confirmed" : " is-unset"}${isSelected ? " is-selected" : ""}`}
                key={control.id}
                type="button"
                onClick={() => onSelectControl(control.id)}
              >
                <div className="action-setup-title">
                  <div>
                    <strong>{control.action}</strong>
                    <span>
                      {control.key} / {control.code}
                    </span>
                  </div>
                  <kbd>{confirmed ? fingerComboLabel(mappings[control.id]) : "Unset"}</kbd>
                </div>
                <div className="action-setup-footer">
                  <span>{fingerComboLabel(draft)}</span>
                  <kbd>{isSelected ? "Editing" : "Select"}</kbd>
                </div>
              </button>
            );
          })}
          {!controls.length && (
            <div className="empty-state">
              <strong>No controls detected</strong>
              <span>Run backend analysis before mapping gestures.</span>
            </div>
          )}
        </div>
      </div>

      <div className="actions">
        <button className="pixel-button secondary" type="button" onClick={onBack}>
          Back
        </button>
        <button className="pixel-button secondary" disabled={!allConfirmed || isPlanningPatch} type="button" onClick={onPlan}>
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

      {conflictPulse && (
        <div className="gesture-plan-card is-warning">
          <div className="board-title">
            <span>Gesture Conflict</span>
            <span className="mini-led">CHECK</span>
          </div>
          <p className="patch-note">Another action already uses this exact finger combo.</p>
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

      fetch(`${apiBaseUrl}/api/camera/stop`, { method: "POST", keepalive: true }).catch(() => {});
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
            hands: Number(state.hands || 0),
            fingers: state.fingers || {},
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

    fetch(`${apiBaseUrl}/api/camera/start`).catch(() => {});
    pollGestureState();

    return () => {
      isMounted = false;

      if (timer) {
        window.clearTimeout(timer);
      }

      fetch(`${apiBaseUrl}/api/camera/stop`, { method: "POST", keepalive: true }).catch(() => {});
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
            const fingers = mappings[control.id];

            return (
              <div className="play-map-row" key={control.id}>
                <span>{control.action}</span>
                <kbd>{Array.isArray(fingers) ? fingerComboLabel(fingers) : "Unmapped"}</kbd>
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

function RecordingPreviewPanel({
  cloudinaryAsset,
  cloudinaryError,
  cloudinaryStatus,
  recordedClip,
  videoAnalysis,
  videoAnalysisError,
  videoAnalysisStatus,
  clipPlan,
  clipPlanDraft,
  clipPlanError,
  clipPlanStatus,
  clipRender,
  clipRenderError,
  clipRenderStatus,
  analysisFeedback,
  analysisPrompt,
  isSavingAnalysisFeedback,
  onBack,
  onClipAssetChange,
  onClipTextChange,
  onClipTrimChange,
  onFeedbackChange,
  onPromptChange,
  onRenderClipPlan,
  onRestart,
  onSubmitFeedback,
}) {
  const transcriptSegments = videoAnalysis?.transcription?.segments ?? [];
  const audioEvents = videoAnalysis?.audio?.events ?? [];
  const highlights = videoAnalysis?.highlights ?? videoAnalysis?.multimodal?.funny_moments ?? [];
  const editablePlan = clipPlanDraft ?? clipPlan;
  const plannedClips = editablePlan?.sequence?.clips ?? [];
  const memeAssets = (editablePlan?.asset_catalog ?? []).filter((asset) => asset.kind === "meme");
  const soundAssets = (editablePlan?.asset_catalog ?? []).filter((asset) => asset.kind === "sound");
  const defaultAssets = [
    { id: "meme_laugh", label: "Laugh Meme", kind: "meme" },
    { id: "meme_embarrassed", label: "Embarrassed Meme", kind: "meme" },
    { id: "sound_laugh", label: "Laugh Sound", kind: "sound" },
    { id: "sound_wtf", label: "WTF Sound", kind: "sound" },
  ];
  const displayedAssets = editablePlan?.asset_catalog?.length ? editablePlan.asset_catalog : defaultAssets;
  const adInsert = clipRender?.ad_insert;
  const clipRenderActive = isClipRenderActive(clipRenderStatus);
  const pipelineSteps = [
    {
      label: "Cloudinary Original",
      value: cloudinaryStatusLabel(cloudinaryStatus),
      state: workflowState(Boolean(cloudinaryAsset?.backend_recording_id), ["uploading", "registering"].includes(cloudinaryStatus), Boolean(cloudinaryError)),
    },
    {
      label: "Whisper Transcript",
      value: videoAnalysisStatus === "complete" || videoAnalysisStatus === "partial" ? `${transcriptSegments.length} SEGMENTS` : videoAnalysisStatusLabel(videoAnalysisStatus),
      state: workflowState(Boolean(transcriptSegments.length), videoAnalysisStatus === "analyzing", Boolean(videoAnalysisError)),
    },
    {
      label: "Audio Signals",
      value: videoAnalysisStatus === "complete" || videoAnalysisStatus === "partial" ? `${audioEvents.length} EVENTS` : videoAnalysisStatusLabel(videoAnalysisStatus),
      state: workflowState(videoAnalysisStatus === "complete" || videoAnalysisStatus === "partial", videoAnalysisStatus === "analyzing", Boolean(videoAnalysisError)),
    },
    {
      label: "Backboard Highlights",
      value: highlights.length ? `${highlights.length} MOMENTS` : videoAnalysisStatusLabel(videoAnalysisStatus),
      state: workflowState(Boolean(highlights.length), videoAnalysisStatus === "analyzing", Boolean(videoAnalysisError)),
    },
    {
      label: "Clip Plan",
      value: plannedClips.length ? `${plannedClips.length} CLIPS` : clipPlanStatusLabel(clipPlanStatus),
      state: workflowState(Boolean(plannedClips.length), ["loading", "planning", "stale"].includes(clipPlanStatus), Boolean(clipPlanError)),
    },
    {
      label: "Manual Tune",
      value: plannedClips.length ? "READY" : "LOCKED",
      state: workflowState(Boolean(plannedClips.length), false, false),
    },
    {
      label: "Ad Insert",
      value: adInsert?.inserted ? "INSERTED" : plannedClips.length ? "FIXED SLOT" : "LOCKED",
      state: workflowState(Boolean(adInsert?.inserted), clipRenderActive && !clipRender?.final_url, Boolean(clipRenderError)),
    },
    {
      label: "Cloudinary MP4",
      value: clipRenderStatusLabel(clipRenderStatus),
      state: workflowState(Boolean(clipRender?.final_url), clipRenderActive, Boolean(clipRenderError)),
    },
  ];

  return (
    <section className="recording-preview-panel" aria-label="Recording preview">
      <p className="eyebrow">Level 04</p>
      <h1 id="page-title">RECORDING PREVIEW</h1>
      <p className="intro">
        Review the last captured play session, then jump back into display mode when you are ready.
      </p>

      <div className="autocut-workflow-board" aria-label="Automatic video editing workflow">
        <div className="board-title">
          <span>Auto Cut Workflow</span>
          <span className="mini-led">{clipRender?.final_url ? "MP4 READY" : plannedClips.length ? "PLAN READY" : videoAnalysisStatusLabel(videoAnalysisStatus)}</span>
        </div>
        <div className="autocut-workflow-grid">
          {pipelineSteps.map((step) => (
            <article className={`workflow-step is-${step.state}`} key={step.label}>
              <span>{workflowStateLabel(step.state)}</span>
              <strong>{step.label}</strong>
              <kbd>{step.value}</kbd>
            </article>
          ))}
        </div>
        <div className="asset-scope-strip" aria-label="Allowed edit assets">
          <span>LOCAL ASSETS ONLY</span>
          {displayedAssets.map((asset) => (
            <kbd key={asset.id}>{asset.label}</kbd>
          ))}
        </div>
      </div>

      {recordedClip?.url ? (
        <div className="recording-preview-grid">
          <div className="recording-player">
            <video src={recordedClip.url} controls autoPlay />
          </div>
          <aside className="recording-summary">
            <div className="board-title">
              <span>Clip Details</span>
              <span className="mini-led">{formatDuration(recordedClip.durationMs)}</span>
            </div>
            <div className="play-map-row">
              <span>Format</span>
              <kbd>{recordedClip.type || "webm"}</kbd>
            </div>
            <div className="play-map-row">
              <span>Size</span>
              <kbd>{formatFileSize(recordedClip.size)}</kbd>
            </div>
            <div className="play-map-row">
              <span>Created</span>
              <kbd>{new Date(recordedClip.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</kbd>
            </div>
            <a className="pixel-button secondary download-link" href={recordedClip.url} download={recordedClip.name}>
              Download
            </a>
            <div className="cloudinary-board">
              <div className="board-title">
                <span>Cloudinary</span>
                <span className="mini-led">{cloudinaryStatusLabel(cloudinaryStatus)}</span>
              </div>
              {cloudinaryAsset?.public_id && (
                <div className="play-map-row">
                  <span>Public ID</span>
                  <kbd>{cloudinaryAsset.public_id}</kbd>
                </div>
              )}
              {cloudinaryAsset?.video_url && (
                <a className="cloudinary-link" href={cloudinaryAsset.video_url} target="_blank" rel="noreferrer">
                  Cloudinary Source
                </a>
              )}
              {cloudinaryError && <p className="recording-error">{cloudinaryError}</p>}
            </div>
          </aside>
        </div>
      ) : (
        <div className="recording-empty">
          <strong>No recording yet</strong>
          <span>Start a recording from the floating control first.</span>
        </div>
      )}

      <div className="actions">
        <button className="pixel-button secondary" type="button" onClick={onBack}>
          Back
        </button>
        <button className="pixel-button" type="button" onClick={onRestart}>
          New Game
        </button>
      </div>

      <div className="video-analysis-board" aria-label="AI video analysis">
        <div className="board-title">
          <span>AI Video Analysis</span>
          <span className="mini-led">{videoAnalysisStatusLabel(videoAnalysisStatus)}</span>
        </div>
        {videoAnalysisError && <p className="recording-error">{videoAnalysisError}</p>}
        {videoAnalysis?.errors?.length ? (
          <p className="patch-note">{videoAnalysis.errors.slice(0, 2).join(" / ")}</p>
        ) : null}

        <div className="analysis-feedback-panel">
          <label>
            <span>Preference Prompt</span>
            <textarea
              placeholder="Example: prioritize absurd fails, keep clips under 6 seconds, ignore quiet setup."
              value={analysisPrompt}
              onChange={(event) => onPromptChange(event.target.value)}
            />
          </label>
          <label>
            <span>Feedback</span>
            <textarea
              placeholder="Example: this missed the funniest scream; next time score loud reactions higher."
              value={analysisFeedback}
              onChange={(event) => onFeedbackChange(event.target.value)}
            />
          </label>
          <button
            className="pixel-button secondary"
            disabled={isSavingAnalysisFeedback || !cloudinaryAsset?.backend_recording_id}
            type="button"
            onClick={onSubmitFeedback}
          >
            {isSavingAnalysisFeedback ? "Applying" : "Remember + Reanalyze"}
          </button>
        </div>

        <div className="analysis-columns">
          <section className="analysis-column">
            <h2>Whisper Transcript</h2>
            {transcriptSegments.slice(0, 5).map((segment) => (
              <div className="analysis-row" key={`${segment.start}-${segment.end}-${segment.text}`}>
                <kbd>{formatSeconds(segment.start)}</kbd>
                <span>{segment.text}</span>
              </div>
            ))}
            {!transcriptSegments.length && <p className="analysis-empty">Waiting for transcript.</p>}
          </section>

          <section className="analysis-column">
            <h2>Audio Signals</h2>
            {audioEvents.slice(0, 6).map((event) => (
              <div className="analysis-row" key={`${event.label}-${event.start}-${event.end}`}>
                <kbd>{formatSeconds(event.start)}</kbd>
                <span>{String(event.label || "audio").replaceAll("_", " ")}</span>
              </div>
            ))}
            {!audioEvents.length && <p className="analysis-empty">No audio events yet.</p>}
          </section>

          <section className="analysis-column">
            <h2>Funny Moments</h2>
            {highlights.slice(0, 5).map((moment) => (
              <div className="analysis-card" key={`${moment.start}-${moment.end}-${moment.title}`}>
                <div>
                  <strong>{moment.title || "Funny Moment"}</strong>
                  <span>{formatSeconds(moment.start)} - {formatSeconds(moment.end)}</span>
                </div>
                <p>{moment.reason || "Multimodal model flagged this segment."}</p>
              </div>
            ))}
            {!highlights.length && <p className="analysis-empty">Waiting for multimodal judgment.</p>}
          </section>
        </div>
      </div>

      <div className="clip-plan-board" aria-label="Cloudinary clip plan">
        <div className="board-title">
          <span>Cloudinary Clip Plan</span>
          <span className="mini-led">{clipPlanStatusLabel(clipPlanStatus)}</span>
        </div>
        {clipPlanError && <p className="recording-error">{clipPlanError}</p>}
        {editablePlan?.output && (
          <p className="patch-note">
            {editablePlan.generator || "backboard.io"} / {editablePlan.output.width}x{editablePlan.output.height} / {editablePlan.output.aspect_ratio} / {editablePlan.output.format}
            {editablePlan.asset_policy?.allowed_asset_ids?.length ? ` / ${editablePlan.asset_policy.allowed_asset_ids.length} LOCAL ASSETS` : ""}
            {editablePlan.output.captions === false ? " / NO SUBTITLES" : ""}
          </p>
        )}
        {editablePlan?.sequence?.strategy && (
          <p className="patch-note">{editablePlan.sequence.strategy}</p>
        )}
        <div className="clip-plan-list">
          {plannedClips.map((clip) => {
            const detailItems = clipPlanDetailItems(clip);

            return (
              <article className="clip-plan-card" key={clip.id}>
                <div className="clip-plan-head">
                  <strong>{clipTitleText(clip)}</strong>
                  <kbd>{formatSeconds(clip.trim?.start)} - {formatSeconds(clip.trim?.end)}</kbd>
                </div>
                <div className="clip-plan-grid">
                  <span>Trim {Number(clip.trim?.duration || 0).toFixed(1)}s</span>
                  <span>Crop {clip.crop?.aspect_ratio || "9:16"} {clip.crop?.width}x{clip.crop?.height}</span>
                  <span>Text {clip.overlays?.filter((overlay) => overlay?.type === "text").length || 0}</span>
                  <span>Audio {clip.audio_signals?.length || 0}</span>
                  <span>Zoom {clip.effects?.zoom?.enabled ? "on" : "off"}</span>
                  <span>Subtitles off</span>
                </div>
                {detailItems.length > 0 && (
                  <div className="clip-detail-list">
                    {detailItems.slice(0, 8).map(([label, value]) => (
                      <div className="clip-detail-row" key={`${clip.id}-${label}`}>
                        <span>{label}</span>
                        <p>{value}</p>
                      </div>
                    ))}
                  </div>
                )}
                <div className="clip-tune-grid">
                  <label>
                    <span>Start</span>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={clip.trim?.start ?? 0}
                      onChange={(event) => onClipTrimChange(clip.id, "start", event.target.value)}
                    />
                  </label>
                  <label>
                    <span>End</span>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={clip.trim?.end ?? 0}
                      onChange={(event) => onClipTrimChange(clip.id, "end", event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Meme</span>
                    <select
                      value={clip.selected_assets?.meme ?? ""}
                      onChange={(event) => onClipAssetChange(clip.id, "meme", event.target.value)}
                    >
                      <option value="">None</option>
                      {memeAssets.map((asset) => (
                        <option key={asset.id} value={asset.id}>{asset.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Sound</span>
                    <select
                      value={clip.selected_assets?.sound ?? ""}
                      onChange={(event) => onClipAssetChange(clip.id, "sound", event.target.value)}
                    >
                      <option value="">None</option>
                      {soundAssets.map((asset) => (
                        <option key={asset.id} value={asset.id}>{asset.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="clip-title-field">
                    <span>Text</span>
                    <input
                      value={clipTitleText(clip)}
                      onChange={(event) => onClipTextChange(clip.id, event.target.value)}
                    />
                  </label>
                </div>
              </article>
            );
          })}
          {!plannedClips.length && <p className="analysis-empty">Waiting for Backboard highlights to generate the edit plan.</p>}
        </div>
      </div>

      <div className="clip-render-board" aria-label="Cloudinary render">
        <div className="board-title">
          <span>Cloudinary MP4</span>
          <span className="mini-led">{clipRenderStatusLabel(clipRenderStatus)}</span>
        </div>
        {clipRenderError && <p className="recording-error">{clipRenderError}</p>}
        <div className="clip-render-actions">
          <button
            className="pixel-button"
            disabled={!plannedClips.length || clipRenderActive || !cloudinaryAsset?.backend_recording_id}
            type="button"
            onClick={onRenderClipPlan}
          >
            {clipRenderActive ? "Rendering" : "Render MP4"}
          </button>
          {clipRender?.download_url && (
            <a className="pixel-button secondary download-link" href={clipRender.download_url} download target="_blank" rel="noreferrer">
              Download MP4
            </a>
          )}
        </div>
        {clipRender?.final_url && (
          <div className="rendered-video">
            <video src={clipRender.final_url} controls />
          </div>
        )}
        {adInsert && (
          <div className="ad-insert-summary" aria-label="Inserted advertisement">
            <div className="play-map-row">
              <span>Entrepreneur Ad</span>
              <kbd>{adInsert.inserted ? adInsert.title || adInsert.ad_id || "Inserted" : "None"}</kbd>
            </div>
            {adInsert.inserted && (
              <div className="play-map-row">
                <span>Placement</span>
                <kbd>After Clip 1</kbd>
              </div>
            )}
            {adInsert.video_url && (
              <a className="cloudinary-link" href={adInsert.video_url} target="_blank" rel="noreferrer">
                Ad Source
              </a>
            )}
          </div>
        )}
        {clipRender?.final_public_id && (
          <div className="play-map-row">
            <span>Final ID</span>
            <kbd>{clipRender.final_public_id}</kbd>
          </div>
        )}
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
          const fingers = mappings[control.id];

          return (
            <div className="mapping-row" key={control.id}>
              <span>{control.action}</span>
              <kbd>{Array.isArray(fingers) ? fingerComboLabel(fingers) : control.key}</kbd>
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

function FieldEditor({ label, value, onChange, rows = 4 }) {
  return (
    <label className="backboard-field">
      <span>{label}</span>
      <textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function VoiceScriptEditor({ plan, onGenerateVoice, onPlanChange }) {
  const segments = Array.isArray(plan.script.segments) ? plan.script.segments : [];
  const isGeneratingVoice = plan.script.audio_status === "loading";

  return (
    <div className="voice-script-workflow">
      <div className="voice-script-head">
        <span>Voice Script</span>
        <small>7-10s</small>
      </div>

      <div className="voice-segment-list">
        {segments.map((segment, index) => (
          <div className="voice-segment-row" key={`${segment.start}-${segment.end}-${index}`}>
            <label>
              <span>Start</span>
              <input
                min="0"
                max="10"
                step="0.5"
                type="number"
                value={segment.start}
                onChange={(event) => onPlanChange(["script", "segments", index, "start"], Number(event.target.value))}
              />
            </label>
            <label>
              <span>End</span>
              <input
                min="0.5"
                max="10"
                step="0.5"
                type="number"
                value={segment.end}
                onChange={(event) => onPlanChange(["script", "segments", index, "end"], Number(event.target.value))}
              />
            </label>
            <label className="voice-line-field">
              <span>{Number(segment.start).toFixed(1)}-{Number(segment.end).toFixed(1)}s</span>
              <textarea rows={2} value={segment.text} onChange={(event) => onPlanChange(["script", "segments", index, "text"], event.target.value)} />
            </label>
          </div>
        ))}
      </div>

      <div className="voice-audio-card">
        <div>
          <span>ElevenLabs Voice</span>
          <p>{plan.script.audio_status === "ready" ? "Human voice ready." : plan.script.audio_status === "failed" ? plan.script.audio_error : "Generate the current timed script as human voice."}</p>
        </div>
        <button className="pixel-button secondary" disabled={isGeneratingVoice} type="button" onClick={onGenerateVoice}>
          {isGeneratingVoice ? "Generating" : "Generate Human Voice"}
        </button>
        {plan.script.audio_url && <audio controls src={plan.script.audio_url} />}
      </div>
    </div>
  );
}

function BackboardStageShell({ eyebrow, title, children }) {
  return (
    <section className="company-stage-panel" aria-label={title}>
      <div className="company-stage-header">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function AssetWorkflowPanel({ plan, onGenerateImage, onGenerateVideo, onGenerateVoice, onPlanChange, isGeneratingVideo, videoError }) {
  if (!plan) {
    return (
      <section className="company-stage-panel company-empty-panel asset-workflow-panel" aria-label="Idea workflow">
        <div>
          <p className="eyebrow">Workflow</p>
          <h2>Drafts Appear Here</h2>
          <p className="generated-empty-copy">Product DNA, image prompt, voice script, and RAG edits will appear after upload.</p>
        </div>
      </section>
    );
  }

  const hasVoiceAudio = Boolean(plan.script?.audio_base64 || String(plan.script?.audio_url ?? "").startsWith("data:"));
  const videoStatus = videoError || (!hasVoiceAudio ? "Generate human voice first, then combine it with the asset video." : plan.video.status || "Use the approved assets to open the video layer.");

  return (
    <section className="company-stage-panel asset-workflow-panel" aria-label="Idea workflow">
      <div className="company-stage-header">
        <p className="eyebrow">Workflow</p>
        <h2>Backboard Drafts</h2>
      </div>

      <div className="generated-ad-layer">
        <span>Same Layer</span>
        <div className="backboard-editor-grid">
          <FieldEditor label="Product DNA" rows={5} value={plan.dna.positioning} onChange={(value) => onPlanChange(["dna", "positioning"], value)} />
          <FieldEditor label="Image Prompt" rows={5} value={plan.image.prompt} onChange={(value) => onPlanChange(["image", "prompt"], value)} />
          <div className="workflow-image-card">
            <span>Generated Image</span>
            <div className="image-regenerate-layout">
              <div className="generated-image-frame">
                {plan.image.status === "loading" ? (
                  <div className="fake-generation-loader" aria-label="Generating image">
                    <i />
                    <p>Generating image asset...</p>
                  </div>
                ) : plan.image.image_url ? (
                  <img alt={`${plan.productName} generated product ad`} src={plan.image.image_url} />
                ) : (
                  <p>{plan.image.status || "Backboard will return an image asset or an image generation prompt here."}</p>
                )}
              </div>
              <label className="image-prompt-dialog">
                <span>Image Request</span>
                <textarea
                  rows={5}
                  value={plan.image.regeneratePrompt ?? ""}
                  placeholder="Ask for a new image direction"
                  onChange={(event) => onPlanChange(["image", "regeneratePrompt"], event.target.value)}
                />
                <button className="pixel-button" disabled={plan.image.status === "loading"} type="button" onClick={onGenerateImage}>
                  {plan.image.status === "loading" ? "Regenerating" : "Regenerate"}
                </button>
              </label>
            </div>
          </div>
          <VoiceScriptEditor plan={plan} onGenerateVoice={onGenerateVoice} onPlanChange={onPlanChange} />
          <FieldEditor label="RAG + Revisions" rows={4} value={plan.rag.revisionInstruction} onChange={(value) => onPlanChange(["rag", "revisionInstruction"], value)} />
          <div className="video-generate-card">
            <span>Video</span>
            <p>{videoStatus}</p>
            <button className="pixel-button" disabled={isGeneratingVideo || !hasVoiceAudio} type="button" onClick={onGenerateVideo}>
              {isGeneratingVideo ? "Combining With Cloudinary" : "Generate Video"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function GeneratedAdsPanel({ plan, isGeneratingVideo, videoError, onPromptChange, onRegenerateVideo, onSubmitVideo }) {
  if (!plan) {
    return (
      <section className="company-stage-panel company-empty-panel generated-ads-panel" aria-label="Generated ads">
        <div>
          <p className="eyebrow">Generated Ads</p>
          <h2>No Video Yet</h2>
          <p className="generated-empty-copy">Upload your idea first, then generate the final video from the approved assets.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="generated-ads-panel video-only-panel" aria-label="Generated ads">
      <div className="generated-video-main">
        {isGeneratingVideo ? (
          <div className="generated-video-preview fake-video-loading" aria-label="Generating video">
            <div className="fake-generation-loader">
              <i />
              <p>Combining voice and asset video in Cloudinary...</p>
            </div>
          </div>
        ) : plan.video.video_url ? (
          <div className="generated-video-preview rendered-video-frame" aria-label="Generated Cloudinary video">
            <video className="generated-video-player" controls playsInline src={plan.video.video_url} />
          </div>
        ) : (
          <div className="generated-video-preview video-empty-frame" aria-label="Generated video placeholder">
            <span>{plan.brandName}</span>
            <strong>{plan.productName}</strong>
            <p>{videoError || plan.video.status || "Video layer ready."}</p>
          </div>
        )}
      </div>

      <aside className="video-prompt-panel" aria-label="Video prompt controls">
        <span>Video Prompt</span>
        <textarea
          rows={8}
          value={plan.video.regeneratePrompt ?? ""}
          placeholder="Ask for a different cut, mood, pacing, CTA, or product emphasis"
          onChange={(event) => onPromptChange(event.target.value)}
        />
        <div className="video-prompt-actions">
          <button className="pixel-button secondary" disabled={isGeneratingVideo} type="button" onClick={onRegenerateVideo}>
            {isGeneratingVideo ? "Regenerating" : "Regenerate"}
          </button>
          <button className="pixel-button" disabled={isGeneratingVideo || !plan.video.video_url} type="button" onClick={onSubmitVideo}>
            Submit
          </button>
        </div>
        <p>{videoError || plan.video.status || "Ready for final review."}</p>
      </aside>
    </section>
  );
}

function CompanyMockup({ plan, selectedFormat, onFormatChange }) {
  const [spin, setSpin] = useState(-24);
  const [tilt, setTilt] = useState(-8);
  const [isDragging, setIsDragging] = useState(false);
  const palette = plan?.palette ?? companyPalettes[0];
  const colors = palette.colors;
  const label = plan?.packaging?.frontCopy ?? "Product";
  const brand = plan?.brandName ?? "Company";

  function updateFromPointer(event) {
    if (!isDragging) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    setSpin(Math.round((x - 0.5) * 86));
    setTilt(Math.round((0.5 - y) * 42));
  }

  return (
    <aside className="mockup-board" aria-label="Packaging mockup">
      <div className="board-title">
        <span>3D Mockup</span>
        <span className="mini-led">LIVE</span>
      </div>
      <div className="mockup-format-row" role="group" aria-label="Packaging format">
        {mockupFormats.map((format) => (
          <button
            className={selectedFormat === format.id ? "is-active" : ""}
            key={format.id}
            type="button"
            onClick={() => onFormatChange(format.id)}
          >
            {format.label}
          </button>
        ))}
      </div>
      <div
        className="product-mockup-stage"
        onPointerDown={(event) => {
          setIsDragging(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={updateFromPointer}
        onPointerUp={() => setIsDragging(false)}
        onPointerCancel={() => setIsDragging(false)}
      >
        <div
          className={`mockup-object is-${selectedFormat}`}
          style={{
            "--mockup-spin": `${spin}deg`,
            "--mockup-tilt": `${tilt}deg`,
            "--mockup-base": colors[0],
            "--mockup-accent": colors[1],
            "--mockup-pop": colors[2],
            "--mockup-mark": colors[3],
          }}
        >
          <div className="mockup-face front">
            <span>{brand}</span>
            <strong>{label}</strong>
            <small>{plan?.brief?.cta ?? "Launch Draft"}</small>
          </div>
          <div className="mockup-face back">
            <span>{palette.name}</span>
            <strong>{plan?.packaging?.shelfSignal ?? "Signal Benefit"}</strong>
          </div>
          <div className="mockup-face left" />
          <div className="mockup-face right" />
          <div className="mockup-face top" />
          <div className="mockup-face bottom" />
          {selectedFormat === "bottle" && <span className="mockup-cap" />}
        </div>
      </div>
      <div className="mockup-control-grid">
        <label>
          <span>Spin</span>
          <input type="range" min="-60" max="60" value={spin} onChange={(event) => setSpin(Number(event.target.value))} />
        </label>
        <label>
          <span>Tilt</span>
          <input type="range" min="-28" max="28" value={tilt} onChange={(event) => setTilt(Number(event.target.value))} />
        </label>
      </div>
    </aside>
  );
}

function BackboardPreview({ plan }) {
  const palette = plan?.palette ?? companyPalettes[0];
  const colors = palette.colors;
  const productName = plan?.productName ?? "Product";
  const brandName = plan?.brandName ?? "Company";

  return (
    <aside className="backboard-preview-board" aria-label="Backboard generated assets preview">
      <div className="board-title">
        <span>Backboard Outputs</span>
        <span className="mini-led">RAG READY</span>
      </div>

      <div
        className="generated-image-preview"
        style={{
          "--image-base": colors[0],
          "--image-accent": colors[1],
          "--image-pop": colors[2],
          "--image-mark": colors[3],
        }}
      >
        <div className="generated-product-card">
          <span>{brandName}</span>
          <strong>{productName}</strong>
          <small>{plan?.dna?.strategy ?? "Generate Product DNA first"}</small>
        </div>
      </div>

      <div className="backboard-output-stack">
        <article>
          <span>Image</span>
          <p>{plan?.image?.status ?? "Waiting for product input."}</p>
        </article>
        <article>
          <span>Voice Script</span>
          <p>{plan?.script?.segments ? voiceScriptText(plan.script.segments) : "A short 10-second script will appear here."}</p>
        </article>
        <article>
          <span>Video</span>
          <p>{plan?.video?.status ?? "Video generation will use the approved DNA, image, and script."}</p>
        </article>
      </div>
    </aside>
  );
}

function EntrepreneurWorkspace({ authProfile, onLogout }) {
  const fakeGenerationTimersRef = useRef([]);
  const [companyName, setCompanyName] = useState("");
  const [productIdea, setProductIdea] = useState("");
  const [ragContext, setRagContext] = useState("");
  const [companyPage, setCompanyPage] = useState("upload");
  const [plan, setPlan] = useState(null);
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
  const [videoError, setVideoError] = useState("");
  const [hasOpenedVideoLayer, setHasOpenedVideoLayer] = useState(false);
  const canGenerate = companyName.trim() && productIdea.trim();

  useEffect(() => () => {
    fakeGenerationTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    fakeGenerationTimersRef.current = [];
  }, []);

  function queueFakeGeneration(callback, delay = 1400) {
    const timer = window.setTimeout(() => {
      fakeGenerationTimersRef.current = fakeGenerationTimersRef.current.filter((item) => item !== timer);
      callback();
    }, delay);

    fakeGenerationTimersRef.current.push(timer);
  }

  function startFakeImageGeneration(basePlan, request = "") {
    const imageRequest = String(request ?? "").trim();

    setPlan({
      ...basePlan,
      image: {
        ...basePlan.image,
        image_url: "",
        status: "loading",
        regeneratePrompt: imageRequest || basePlan.image?.regeneratePrompt || "",
      },
    });

    queueFakeGeneration(() => {
      setPlan((currentPlan) => currentPlan
        ? {
            ...currentPlan,
            image: {
              ...currentPlan.image,
              image_url: fakeGeneratedImageUrl,
              status: imageRequest ? `Regenerated from local asset: ${imageRequest}` : "Generated from local asset",
              provider: "local_fake_asset",
            },
          }
        : currentPlan);
    });
  }

  function regenerateImage() {
    if (!plan || plan.image?.status === "loading") {
      return;
    }

    startFakeImageGeneration(plan, plan.image?.regeneratePrompt);
  }

  async function generateDraft(event) {
    event.preventDefault();

    if (!canGenerate || isGeneratingPlan) {
      return;
    }

    setIsGeneratingPlan(true);
    setGenerationError("");
    setVideoError("");
    setHasOpenedVideoLayer(false);

    try {
      const response = await fetch(`${apiBaseUrl}/api/ads/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: companyName.trim(),
          product_idea: productIdea.trim(),
          rag_context: ragContext.trim(),
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Backboard generation failed.");
      }

      startFakeImageGeneration(payload.plan);
      setCompanyPage("upload");
    } catch (error) {
      setGenerationError(error.message);
    } finally {
      setIsGeneratingPlan(false);
    }
  }

  function updatePlanValue(path, value) {
    setPlan((currentPlan) => {
      if (!currentPlan) {
        return currentPlan;
      }

      const nextPlan = structuredClone(currentPlan);
      let target = nextPlan;

      path.slice(0, -1).forEach((key) => {
        target = target[key];
      });
      target[path.at(-1)] = value;

      return nextPlan;
    });
  }

  function patchScript(patch) {
    setPlan((currentPlan) => {
      if (!currentPlan) {
        return currentPlan;
      }

      return {
        ...currentPlan,
        script: {
          ...currentPlan.script,
          ...patch,
        },
      };
    });
  }

  async function generateHumanVoice() {
    if (!plan?.script?.segments?.length) {
      return;
    }

    setHasOpenedVideoLayer(false);
    setVideoError("");
    setPlan((currentPlan) => currentPlan
      ? {
          ...currentPlan,
          script: {
            ...currentPlan.script,
            audio_status: "loading",
            audio_error: "",
            audio_url: "",
            audio_base64: "",
            mime_type: "",
            provider: "",
          },
          video: {
            ...currentPlan.video,
            status: "Waiting for the new voice audio before Cloudinary render.",
            video_url: "",
            render: null,
          },
        }
      : currentPlan);

    const currentSegments = plan.script.segments;

    try {
      const response = await fetch(`${apiBaseUrl}/api/ads/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments: currentSegments,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "ElevenLabs voice generation failed.");
      }

      setPlan((currentPlan) => currentPlan
        ? {
            ...currentPlan,
            script: {
              ...currentPlan.script,
              segments: payload.segments ?? currentPlan.script.segments,
              audio_status: "ready",
              audio_error: "",
              audio_url: payload.audio_url,
              audio_base64: payload.audio_base64,
              mime_type: payload.mime_type,
              provider: payload.provider,
              voice_id: payload.voice_id,
              audio_text: payload.text,
            },
            video: {
              ...currentPlan.video,
              status: "New voice ready. Generate Video will combine it with the local asset in Cloudinary.",
              video_url: "",
              render: null,
            },
          }
        : currentPlan);
    } catch (error) {
      patchScript({
        audio_status: "failed",
        audio_error: error.message,
        audio_url: "",
        audio_base64: "",
      });
    }
  }

  async function generateVideo() {
    if (!plan || isGeneratingVideo) {
      return;
    }

    const audioBase64 = plan.script?.audio_base64 || (String(plan.script?.audio_url ?? "").startsWith("data:") ? String(plan.script.audio_url).split(",").at(-1) : "");

    if (!audioBase64) {
      setVideoError("Generate Human Voice first so Cloudinary can combine the latest audio with the asset video.");
      return;
    }

    const requestPlan = {
      ...plan,
      script: {
        ...plan.script,
        audio_base64: audioBase64,
      },
    };

    setIsGeneratingVideo(true);
    setVideoError("");
    setHasOpenedVideoLayer(true);
    setCompanyPage("generated");
    setPlan((currentPlan) => currentPlan
      ? {
          ...currentPlan,
          video: {
            ...currentPlan.video,
            status: "Combining latest ElevenLabs audio with asset video in Cloudinary...",
            video_url: "",
            render: null,
          },
        }
      : currentPlan);

    try {
      const response = await fetch(`${apiBaseUrl}/api/ads/render-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: requestPlan,
          video_asset: companyAdVideoAsset,
          video_prompt: requestPlan.video?.regeneratePrompt ?? "",
          recipient_email: authProfile?.email,
          recipient_name: authProfile?.name,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Cloudinary video render failed.");
      }

      setPlan((currentPlan) => currentPlan
        ? {
            ...currentPlan,
            video: {
              ...currentPlan.video,
              status: payload.email_status === "sent"
                ? "Cloudinary render ready. Email sent to the logged-in user."
                : payload.email_status === "failed"
                  ? "Cloudinary render ready. Email notification failed."
                  : "Cloudinary render ready.",
              video_url: payload.video_url,
              provider: payload.provider,
              source_asset: payload.source_video_asset,
              regeneratePrompt: currentPlan.video.regeneratePrompt ?? "",
              render: payload,
            },
          }
        : currentPlan);
    } catch (error) {
      setVideoError(error.message);
      setPlan((currentPlan) => currentPlan
        ? {
            ...currentPlan,
            video: {
              ...currentPlan.video,
              status: "Cloudinary render failed.",
              video_url: "",
            },
          }
        : currentPlan);
    } finally {
      setIsGeneratingVideo(false);
    }
  }

  function submitGeneratedVideo() {
    if (!plan?.video?.video_url) {
      return;
    }

    setPlan((currentPlan) => currentPlan
      ? {
          ...currentPlan,
          video: {
            ...currentPlan.video,
            status: "Generated ad submitted.",
            submitted_at: new Date().toISOString(),
            submitted_prompt: currentPlan.video.regeneratePrompt ?? "",
          },
        }
      : currentPlan);
  }

  return (
    <main className="app-shell company-app">
      <section className="screen company-screen" aria-labelledby="page-title">
        <div className="top-bar">
          <div className="brand">
            <BrandMark />
            <span>GestureForge</span>
          </div>
          <div className="status-chip">
            <span className="status-light" aria-hidden="true" />
            Company Workspace
          </div>
          <button className="auth-logout" type="button" onClick={onLogout}>
            Logout
          </button>
        </div>

        <nav className="company-page-tabs" aria-label="Company pages">
          <button className={companyPage === "upload" ? "is-active" : ""} type="button" onClick={() => setCompanyPage("upload")}>
            Upload Your Idea
          </button>
          <button
            className={companyPage === "generated" ? "is-active" : ""}
            disabled={!hasOpenedVideoLayer}
            type="button"
            onClick={() => setCompanyPage("generated")}
          >
            Generated Ads
          </button>
        </nav>

        {companyPage === "upload" ? (
          <div className="company-studio-grid">
            <form className="company-input-panel company-upload-page" onSubmit={generateDraft}>
              <p className="eyebrow">Backboard.io Workspace</p>
              <h1 className="company-title" id="page-title">Upload Your Idea</h1>
              <label htmlFor="company-name">
                <span>Company Name</span>
                <input id="company-name" value={companyName} onChange={(event) => setCompanyName(event.target.value)} />
              </label>
              <label htmlFor="product-idea">
                <span>Product Idea</span>
                <textarea
                  id="product-idea"
                  value={productIdea}
                  placeholder="A refillable bottle that tracks hydration and mineral balance"
                  onChange={(event) => setProductIdea(event.target.value)}
                />
              </label>
              <label htmlFor="rag-context">
                <span>RAG Context</span>
                <textarea
                  id="rag-context"
                  value={ragContext}
                  placeholder="Paste brand guidelines, target audience notes, competitor references, product claims, URLs, or internal docs summary"
                  onChange={(event) => setRagContext(event.target.value)}
                />
              </label>
              {generationError && <p className="auth-error">{generationError}</p>}
              <button className="pixel-button" disabled={!canGenerate || isGeneratingPlan} type="submit">
                {isGeneratingPlan ? "Generating With Backboard" : "Start Backboard Flow"}
              </button>
            </form>
            <AssetWorkflowPanel
              plan={plan}
              isGeneratingVideo={isGeneratingVideo}
              videoError={videoError}
              onGenerateImage={regenerateImage}
              onGenerateVideo={generateVideo}
              onGenerateVoice={generateHumanVoice}
              onPlanChange={updatePlanValue}
            />
          </div>
        ) : (
          <div className="generated-ads-page">
            <GeneratedAdsPanel
              plan={plan}
              isGeneratingVideo={isGeneratingVideo}
              videoError={videoError}
              onPromptChange={(value) => updatePlanValue(["video", "regeneratePrompt"], value)}
              onRegenerateVideo={generateVideo}
              onSubmitVideo={submitGeneratedVideo}
            />
          </div>
        )}
      </section>
    </main>
  );
}

export default function App() {
  const fileInputRef = useRef(null);
  const [authProfile, setAuthProfile] = useState(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const recordingStreamRef = useRef(null);
  const recordingStartedAtRef = useRef(0);
  const recordingClipUrlRef = useRef("");
  const recordingCancelledRef = useRef(false);
  const sessionRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [analysis, setAnalysis] = useState(emptyAnalysis);
  const [session, setSession] = useState(null);
  const [sessionStatus, setSessionStatus] = useState("");
  const [mappings, setMappings] = useState({});
  const [draftMappings, setDraftMappings] = useState({});
  const [selectedControlId, setSelectedControlId] = useState("");
  const [conflictPulse, setConflictPulse] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [patchReport, setPatchReport] = useState(null);
  const [isPlanningPatch, setIsPlanningPatch] = useState(false);
  const [isApplyingPatch, setIsApplyingPatch] = useState(false);
  const [patchApplyError, setPatchApplyError] = useState("");

  function authenticate(profile) {
    setAuthProfile(profile);
    window.localStorage.removeItem(savedStateKey);
    setCurrentStep(1);
    setSession(null);
    setSessionStatus("");
    setAnalysis(emptyAnalysis);
  }

  function logout() {
    setAuthProfile(null);
    window.localStorage.removeItem(savedStateKey);
    handleReset();
  }
  const [recordingStatus, setRecordingStatus] = useState("idle");
  const [recordingError, setRecordingError] = useState("");
  const [recordedClip, setRecordedClip] = useState(null);
  const [cloudinaryStatus, setCloudinaryStatus] = useState("idle");
  const [cloudinaryError, setCloudinaryError] = useState("");
  const [cloudinaryAsset, setCloudinaryAsset] = useState(null);
  const [videoAnalysisStatus, setVideoAnalysisStatus] = useState("idle");
  const [videoAnalysisError, setVideoAnalysisError] = useState("");
  const [videoAnalysis, setVideoAnalysis] = useState(null);
  const [clipPlanStatus, setClipPlanStatus] = useState("idle");
  const [clipPlanError, setClipPlanError] = useState("");
  const [clipPlan, setClipPlan] = useState(null);
  const [clipPlanDraft, setClipPlanDraft] = useState(null);
  const [clipRenderStatus, setClipRenderStatus] = useState("idle");
  const [clipRenderError, setClipRenderError] = useState("");
  const [clipRender, setClipRender] = useState(null);
  const [analysisPrompt, setAnalysisPrompt] = useState("");
  const [analysisFeedback, setAnalysisFeedback] = useState("");
  const [isSavingAnalysisFeedback, setIsSavingAnalysisFeedback] = useState(false);

  useEffect(() => {
    const safeStep = currentStep === 4
      ? patchReport?.status === "patched" ? 3 : 2
      : currentStep === 3 && patchReport?.status !== "patched" ? 2 : currentStep;
    window.localStorage.setItem(
      savedStateKey,
      JSON.stringify({
        githubUrl,
        currentStep: safeStep,
        analysis,
        session,
        sessionStatus,
        mappings,
        draftMappings,
        selectedControlId,
        patchReport,
      }),
    );
  }, [githubUrl, currentStep, analysis, session, sessionStatus, mappings, draftMappings, selectedControlId, patchReport]);

  useEffect(() => () => {
    recordingCancelledRef.current = true;

    if (recordingClipUrlRef.current) {
      URL.revokeObjectURL(recordingClipUrlRef.current);
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      return;
    }

    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    let cancelled = false;

    async function refreshRestoredSession() {
      if (!session?.session_id) {
        return;
      }

      try {
        const statusResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.session_id}`);
        const statusPayload = await statusResponse.json();

        if (cancelled) {
          return;
        }

        setSessionStatus(statusPayload.status ?? "");
        setSession((currentSession) => ({ ...currentSession, ...statusPayload }));

        if (statusPayload.status === "ready" && !(analysis.controls ?? []).length) {
          const analysisResponse = await fetch(`${apiBaseUrl}/api/sessions/${session.session_id}/analysis`);
          const nextAnalysis = await analysisResponse.json();

          if (!cancelled) {
            applyAnalysis(statusPayload, nextAnalysis);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      }
    }

    refreshRestoredSession();

    return () => {
      cancelled = true;
    };
  }, []);

  function applyAnalysis(nextSession, nextAnalysis) {
    const dedupedAnalysis = dedupeAnalysisControls(nextAnalysis);
    const nextDraftMappings = Object.fromEntries(
      (dedupedAnalysis.controls ?? []).map((control, index) => [
        control.id,
        index === 0 ? ["index"] : [],
      ]),
    );

    setSession(nextSession);
    setAnalysis(dedupedAnalysis);
    setMappings({});
    setDraftMappings(nextDraftMappings);
    setSelectedControlId(dedupedAnalysis.controls?.[0]?.id ?? "");
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
      setSession((currentSession) => ({ ...(currentSession ?? {}), ...statusPayload }));

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
    setAnalysis(emptyAnalysis);
    setPatchReport(null);
    setPatchApplyError("");
    setMappings({});
    setDraftMappings({});
    setSelectedControlId("");

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
    setAnalysis(emptyAnalysis);
    setPatchReport(null);
    setPatchApplyError("");
    setMappings({});
    setDraftMappings({});
    setSelectedControlId("");

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
        const fingers = normalizeFingerCombo(mappings[control.id] ?? []);

        return {
          control_id: control.id,
          key: control.key,
          code: control.code,
          action: control.action,
          gesture: fingerComboKey(fingers),
          gesture_fingers: fingers,
          gesture_label: fingerComboLabel(fingers),
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

  function stopRecordingTracks(stream = recordingStreamRef.current) {
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });

    if (stream === recordingStreamRef.current) {
      recordingStreamRef.current = null;
    }
  }

  function revokeRecordedClip() {
    if (recordingClipUrlRef.current) {
      URL.revokeObjectURL(recordingClipUrlRef.current);
      recordingClipUrlRef.current = "";
    }
  }

  function clearRecordedClip() {
    revokeRecordedClip();
    setRecordedClip(null);
  }

  async function registerCloudinaryRecording(asset, clip) {
    const currentSession = sessionRef.current;
    const response = await fetch(`${apiBaseUrl}/api/recordings/cloudinary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bytes: asset.bytes ?? clip.size,
        duration: asset.duration ?? clip.durationMs / 1000,
        format: asset.format,
        height: asset.height,
        original_filename: clip.name,
        public_id: asset.public_id,
        resource_type: asset.resource_type ?? "video",
        session_id: currentSession?.session_id ?? null,
        source: "gestureforge_screen_recording",
        type: asset.type ?? clip.type,
        video_url: asset.video_url,
        width: asset.width,
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Backend could not store Cloudinary video metadata.");
    }

    return payload;
  }

  async function uploadRecordingThroughBackend(clip) {
    const currentSession = sessionRef.current;
    const response = await fetch(`${apiBaseUrl}/api/recordings/upload`, {
      method: "POST",
      headers: {
        "Content-Type": clip.blob.type || "video/webm",
        "X-Recording-Duration-Ms": String(clip.durationMs || 0),
        "X-Recording-Filename": encodeURIComponent(clip.name || "gestureforge-recording.webm"),
        "X-Recording-Size": String(clip.size || clip.blob.size || 0),
        "X-Session-Id": currentSession?.session_id ?? "",
      },
      body: clip.blob,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("Backend upload endpoint is not loaded yet. Restart the backend so Cloudinary signed upload can run.");
      }

      throw new Error(payload.error || "Backend Cloudinary upload failed.");
    }

    return {
      bytes: payload.bytes,
      duration: payload.duration,
      format: payload.format,
      height: payload.height,
      public_id: payload.public_id,
      resource_type: payload.resource_type,
      type: payload.type,
      video_url: payload.video_url,
      width: payload.width,
      backend_recording_id: payload.recording_id,
    };
  }

  async function pollVideoAnalysis(recordingId) {
    const startedAt = Date.now();
    setVideoAnalysisStatus("queued");
    setVideoAnalysisError("");
    setVideoAnalysis(null);

    while (Date.now() - startedAt < 900000) {
      try {
        const response = await fetch(`${apiBaseUrl}/api/recordings/${recordingId}/analysis`, {
          cache: "no-store",
        });
        const payload = await response.json();

        if (response.ok && payload.analysis) {
          setVideoAnalysis(payload.analysis);
          setVideoAnalysisStatus(payload.analysis_status || payload.analysis.status || "complete");
          fetchClipPlan(recordingId);
          return;
        }

        if (response.status === 500 || payload.analysis_status === "failed") {
          throw new Error(payload.error || "Video analysis failed.");
        }

        setVideoAnalysisStatus(payload.analysis_status || "analyzing");
      } catch (error) {
        setVideoAnalysisStatus("failed");
        setVideoAnalysisError(error.message);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    setVideoAnalysisStatus("failed");
    setVideoAnalysisError("Video analysis timed out.");
  }

  async function fetchClipPlan(recordingId) {
    setClipPlanStatus("loading");
    setClipPlanError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/recordings/${recordingId}/clip-plan`, {
        cache: "no-store",
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not generate clip plan.");
      }

      setClipPlan(payload.plan);
      setClipPlanDraft(cloneClipPlan(payload.plan));
      setClipPlanStatus(payload.clip_plan_status || payload.plan?.status || "planned");
      fetchClipRender(recordingId);
    } catch (error) {
      setClipPlanStatus("failed");
      setClipPlanError(error.message);
    }
  }

  async function fetchClipRender(recordingId) {
    setClipRenderStatus("loading");
    setClipRenderError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/recordings/${recordingId}/render`, {
        cache: "no-store",
      });
      const payload = await response.json();

      if (response.status === 404) {
        setClipRender(null);
        setClipRenderStatus("idle");
        return;
      }

      if (!response.ok) {
        throw new Error(payload.error || "Could not load rendered MP4.");
      }

      setClipRender(payload.render);
      setClipRenderStatus(payload.clip_render_status || payload.render?.status || "rendered");
    } catch (error) {
      setClipRenderStatus("failed");
      setClipRenderError(error.message);
    }
  }

  function markClipRenderStale() {
    setClipRenderError("");
    setClipRenderStatus((currentStatus) => (clipRender || currentStatus === "rendered" ? "stale" : currentStatus));
  }

  function updateClipPlanDraft(mutator) {
    markClipRenderStale();
    setClipPlanDraft((currentPlan) => {
      const nextPlan = cloneClipPlan(currentPlan ?? clipPlan);

      if (!nextPlan) {
        return currentPlan;
      }

      mutator(nextPlan);
      return nextPlan;
    });
  }

  function updateClipTrim(clipId, field, value) {
    updateClipPlanDraft((nextPlan) => {
      const clip = nextPlan.sequence?.clips?.find((item) => item.id === clipId);

      if (!clip) {
        return;
      }

      const nextValue = Math.max(0, Number(value) || 0);
      const trim = clip.trim ?? { start: 0, end: 1, duration: 1 };

      if (field === "start") {
        trim.start = nextValue;
        trim.end = Math.max(trim.end ?? nextValue + 0.8, nextValue + 0.8);
      } else {
        trim.end = Math.max(nextValue, (trim.start ?? 0) + 0.8);
      }

      trim.duration = Number(Math.max(0.8, trim.end - trim.start).toFixed(2));
      clip.trim = {
        ...trim,
        start: Number(trim.start.toFixed(2)),
        end: Number(trim.end.toFixed(2)),
      };
    });
  }

  function updateClipAsset(clipId, kind, value) {
    updateClipPlanDraft((nextPlan) => {
      const clip = nextPlan.sequence?.clips?.find((item) => item.id === clipId);

      if (!clip) {
        return;
      }

      clip.selected_assets = {
        ...(clip.selected_assets ?? {}),
        [kind]: value || null,
      };
    });
  }

  function updateClipText(clipId, value) {
    updateClipPlanDraft((nextPlan) => {
      const clip = nextPlan.sequence?.clips?.find((item) => item.id === clipId);

      if (!clip) {
        return;
      }

      clip.overlays = Array.isArray(clip.overlays) ? clip.overlays : [];

      let titleOverlay = clip.overlays.find((overlay) => overlay?.type === "text" && overlay.role === "meme_title");

      if (!titleOverlay) {
        titleOverlay = {
          type: "text",
          role: "meme_title",
          position: "top",
          start: 0,
          duration: Math.min(2.8, Number(clip.trim?.duration || 2.8)),
        };
        clip.overlays.unshift(titleOverlay);
      }

      titleOverlay.text = value;
    });
  }

  async function renderClipPlanToCloudinary() {
    const recordingId = cloudinaryAsset?.backend_recording_id;

    if (!recordingId) {
      setClipRenderError("Cloudinary recording must be stored before rendering.");
      return;
    }

    setClipRenderStatus("rendering");
    setClipRenderError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/recordings/${recordingId}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: clipPlanDraft ?? clipPlan,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Cloudinary render failed.");
      }

      setClipRender(payload.render);
      setClipRenderStatus(payload.clip_render_status || payload.render?.status || "rendered");
    } catch (error) {
      setClipRenderStatus("failed");
      setClipRenderError(error.message);
    }
  }

  async function submitVideoAnalysisFeedback() {
    const recordingId = cloudinaryAsset?.backend_recording_id;

    if (!recordingId) {
      setVideoAnalysisError("Cloudinary recording must be stored before feedback can be applied.");
      return;
    }

    setIsSavingAnalysisFeedback(true);
    setVideoAnalysisError("");

    try {
      const response = await fetch(`${apiBaseUrl}/api/recordings/${recordingId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: analysisPrompt,
          feedback: analysisFeedback,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not save analysis feedback.");
      }

      setVideoAnalysis(null);
      setClipPlan(null);
      setClipPlanDraft(null);
      setClipPlanStatus("stale");
      setClipPlanError("");
      setClipRender(null);
      setClipRenderStatus("stale");
      setClipRenderError("");
      setVideoAnalysisStatus(payload.analysis_status || "queued");
      pollVideoAnalysis(recordingId);
    } catch (error) {
      setVideoAnalysisStatus("failed");
      setVideoAnalysisError(error.message);
    } finally {
      setIsSavingAnalysisFeedback(false);
    }
  }

  async function uploadRecordingToCloudinary(clip) {
    setCloudinaryStatus("uploading");
    setCloudinaryError("");
    setCloudinaryAsset(null);

    let uploadedAsset = null;

    try {
      if (!cloudinaryCloudName || !cloudinaryUploadPreset) {
        uploadedAsset = await uploadRecordingThroughBackend(clip);
        setCloudinaryAsset(uploadedAsset);
        setCloudinaryStatus("stored");
        pollVideoAnalysis(uploadedAsset.backend_recording_id);
        return;
      }

      const formData = new FormData();
      formData.append("file", clip.blob, clip.name);
      formData.append("upload_preset", cloudinaryUploadPreset);
      formData.append("tags", "gestureforge,screen-recording");

      if (cloudinaryUploadFolder) {
        formData.append("folder", cloudinaryUploadFolder);
      }

      const uploadResponse = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/video/upload`, {
        method: "POST",
        body: formData,
      });
      const uploadPayload = await uploadResponse.json();

      if (!uploadResponse.ok) {
        throw new Error(uploadPayload.error?.message || "Cloudinary upload failed.");
      }

      uploadedAsset = {
        bytes: uploadPayload.bytes,
        duration: uploadPayload.duration,
        format: uploadPayload.format,
        height: uploadPayload.height,
        public_id: uploadPayload.public_id,
        resource_type: uploadPayload.resource_type,
        type: uploadPayload.type,
        video_url: uploadPayload.secure_url || uploadPayload.url,
        width: uploadPayload.width,
      };

      if (!uploadedAsset.public_id || !uploadedAsset.video_url) {
        throw new Error("Cloudinary response did not include public_id or video URL.");
      }

      setCloudinaryAsset(uploadedAsset);
      setCloudinaryStatus("registering");

      const backendPayload = await registerCloudinaryRecording(uploadedAsset, clip);
      setCloudinaryAsset({
        ...uploadedAsset,
        backend_recording_id: backendPayload.recording_id,
      });
      setCloudinaryStatus("stored");
      pollVideoAnalysis(backendPayload.recording_id);
    } catch (error) {
      setCloudinaryError(error.message);
      setCloudinaryStatus(uploadedAsset ? "backend_failed" : "failed");
    }
  }

  async function startRecording() {
    if (recordingStatus === "recording" || recordingStatus === "starting") {
      return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") {
      setRecordingError("Screen recording is not supported in this browser.");
      return;
    }

    setRecordingStatus("starting");
    setRecordingError("");
    setCloudinaryStatus("idle");
    setCloudinaryError("");
    setCloudinaryAsset(null);
    setVideoAnalysisStatus("idle");
    setVideoAnalysisError("");
    setVideoAnalysis(null);
    setClipPlanStatus("idle");
    setClipPlanError("");
    setClipPlan(null);
    setClipPlanDraft(null);
    setClipRenderStatus("idle");
    setClipRenderError("");
    setClipRender(null);
    setAnalysisFeedback("");

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      const mimeType = supportedRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      recordedChunksRef.current = [];
      recordingCancelledRef.current = false;
      recordingStartedAtRef.current = Date.now();
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          recordedChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = (event) => {
        setRecordingError(event.error?.message || "Recording failed.");
        setRecordingStatus("idle");
        stopRecordingTracks(stream);
      };
      recorder.onstop = () => {
        const chunks = [...recordedChunksRef.current];
        const durationMs = Date.now() - recordingStartedAtRef.current;

        stopRecordingTracks(stream);
        recordedChunksRef.current = [];
        mediaRecorderRef.current = null;

        if (recordingCancelledRef.current) {
          setRecordingStatus("idle");
          return;
        }

        if (!chunks.length) {
          setRecordingError("No video data was captured.");
          setRecordingStatus("idle");
          return;
        }

        const blob = new Blob(chunks, { type: mimeType || chunks[0]?.type || "video/webm" });
        const createdAt = new Date();
        const url = URL.createObjectURL(blob);
        const clip = {
          blob,
          createdAt: createdAt.toISOString(),
          durationMs,
          name: `gestureforge-recording-${createdAt.toISOString().replace(/[:.]/g, "-")}.webm`,
          size: blob.size,
          type: blob.type,
          url,
        };

        revokeRecordedClip();
        recordingClipUrlRef.current = url;
        setRecordedClip(clip);
        setRecordingStatus("ready");
        setCurrentStep(4);
        uploadRecordingToCloudinary(clip);
      };

      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          if (mediaRecorderRef.current?.state === "recording") {
            setRecordingStatus("stopping");
            mediaRecorderRef.current.stop();
          }
        };
      });

      recorder.start(250);
      setRecordingStatus("recording");
    } catch (error) {
      stopRecordingTracks();
      setRecordingStatus("idle");
      setRecordingError(error.name === "NotAllowedError" ? "Screen recording was cancelled." : error.message);
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;

    if (!recorder || recorder.state === "inactive") {
      setRecordingStatus(recordedClip?.url ? "ready" : "idle");
      return;
    }

    setRecordingStatus("stopping");
    recorder.requestData?.();
    recorder.stop();
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
    clearRecordedClip();
    updateSelectedFile(null);
    setGithubUrl("");
    setAnalysis(emptyAnalysis);
    setSession(null);
    setSessionStatus("");
    setMappings({});
    setDraftMappings({});
    setSelectedControlId("");
    setConflictPulse(false);
    setPatchReport(null);
    setIsApplyingPatch(false);
    setPatchApplyError("");
    setErrorMessage("");
    setRecordingError("");
    setCloudinaryStatus("idle");
    setCloudinaryError("");
    setCloudinaryAsset(null);
    setVideoAnalysisStatus("idle");
    setVideoAnalysisError("");
    setVideoAnalysis(null);
    setClipPlanStatus("idle");
    setClipPlanError("");
    setClipPlan(null);
    setClipPlanDraft(null);
    setClipRenderStatus("idle");
    setClipRenderError("");
    setClipRender(null);
    setAnalysisPrompt("");
    setAnalysisFeedback("");
    setIsSavingAnalysisFeedback(false);
    window.localStorage.removeItem(savedStateKey);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleRestart() {
    handleReset();
    setCurrentStep(1);
  }

  function updateDraftMapping(controlId, fingers) {
    setDraftMappings((currentDrafts) => ({
      ...currentDrafts,
      [controlId]: normalizeFingerCombo(fingers),
    }));
  }

  function confirmMapping(controlId) {
    const nextCombo = normalizeFingerCombo(draftMappings[controlId] ?? []);
    const nextKey = fingerComboKey(nextCombo);
    const hasConflict = Object.entries(mappings).some(
      ([otherControlId, fingers]) => otherControlId !== controlId && fingerComboKey(fingers) === nextKey,
    );

    if (hasConflict) {
      setConflictPulse(true);
      window.setTimeout(() => setConflictPulse(false), 520);
      return;
    }

    setMappings((currentMappings) => ({
      ...currentMappings,
      [controlId]: nextCombo,
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

    if (step === 3) {
      return Boolean(session?.session_id && analysis.controls?.length && patchReport?.status === "patched");
    }

    if (step === 4) {
      return true;
    }

    return false;
  }

  function renderStep() {
    if (currentStep === 2) {
      return (
        <ChooseGesturePanel
          analysis={analysis}
          isApplyingPatch={isApplyingPatch}
          isPlanningPatch={isPlanningPatch}
          conflictPulse={conflictPulse}
          draftMappings={draftMappings}
          mappings={mappings}
          selectedControlId={selectedControlId}
          onApplyPlan={applyConfirmedPatchPlan}
          onBack={() => setCurrentStep(1)}
          onConfirmMapping={confirmMapping}
          onDisplay={() => setCurrentStep(3)}
          onDraftMappingChange={updateDraftMapping}
          onPlan={saveMappingAndPlan}
          onSelectControl={setSelectedControlId}
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

    if (currentStep === 4) {
      return (
        <RecordingPreviewPanel
          cloudinaryAsset={cloudinaryAsset}
          cloudinaryError={cloudinaryError}
          cloudinaryStatus={cloudinaryStatus}
          recordedClip={recordedClip}
          videoAnalysis={videoAnalysis}
          videoAnalysisError={videoAnalysisError}
          videoAnalysisStatus={videoAnalysisStatus}
          clipPlan={clipPlan}
          clipPlanDraft={clipPlanDraft}
          clipPlanError={clipPlanError}
          clipPlanStatus={clipPlanStatus}
          clipRender={clipRender}
          clipRenderError={clipRenderError}
          clipRenderStatus={clipRenderStatus}
          analysisFeedback={analysisFeedback}
          analysisPrompt={analysisPrompt}
          isSavingAnalysisFeedback={isSavingAnalysisFeedback}
          onBack={() => setCurrentStep(canOpenStep(3) ? 3 : analysis.controls?.length ? 2 : 1)}
          onClipAssetChange={updateClipAsset}
          onClipTextChange={updateClipText}
          onClipTrimChange={updateClipTrim}
          onFeedbackChange={setAnalysisFeedback}
          onPromptChange={setAnalysisPrompt}
          onRenderClipPlan={renderClipPlanToCloudinary}
          onRestart={handleRestart}
          onSubmitFeedback={submitVideoAnalysisFeedback}
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

  const recordingOverlay = (
    <RecordingControl
      recordedClip={recordedClip}
      recordingError={recordingError}
      recordingStatus={recordingStatus}
      onPreviewRecording={() => setCurrentStep(4)}
      onStartRecording={startRecording}
      onStopRecording={stopRecording}
    />
  );

  if (!authProfile) {
    return <AuthGate onAuthenticate={authenticate} />;
  }

  if (authProfile.role !== "player") {
    return <EntrepreneurWorkspace authProfile={authProfile} onLogout={logout} />;
  }

  if (currentStep === 3) {
    return (
      <>
        {renderStep()}
        {recordingOverlay}
      </>
    );
  }

  return (
    <>
      <main className="app-shell">
        <section className="screen" aria-labelledby="page-title">
          <div className="top-bar">
            <div className="brand">
              <BrandMark />
              <span>GestureForge</span>
            </div>
            <div className="status-chip">
              <span className="status-light" aria-hidden="true" />
              {roleLabel(authProfile.role)}
            </div>
            <button className="auth-logout" type="button" onClick={logout}>
              Logout
            </button>
          </div>

          <StepTabs currentStep={currentStep} onStepChange={setCurrentStep} canOpenStep={canOpenStep} />

          <div className={`hero-grid${currentStep === 2 || currentStep === 4 ? " gesture-editor-grid" : ""}`}>
            {renderStep()}
            {currentStep !== 2 && currentStep !== 4 && <GesturePreview analysis={analysis} mappings={mappings} />}
          </div>
        </section>
      </main>
      {recordingOverlay}
    </>
  );
}
