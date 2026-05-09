import { useMemo, useRef, useState } from "react";

const acceptedGameTypes = ".zip,.exe,.html,.wasm,.gba,.nes,.gb,.gbc,.js";

const defaultMappings = [
  { gesture: "Swipe Left", key: "Move Left", command: "A" },
  { gesture: "Swipe Right", key: "Move Right", command: "D" },
  { gesture: "Open Palm", key: "Jump", command: "Space" },
  { gesture: "Pinch", key: "Action", command: "Ctrl" },
];

const gesturePresets = [
  {
    id: "arcade",
    name: "Arcade Move Set",
    description: "Fast hand motions for platformers, fighters, and action games.",
    mappings: defaultMappings,
  },
  {
    id: "racer",
    name: "Racer Move Set",
    description: "Tilt, pinch, and palm controls for driving games.",
    mappings: [
      { gesture: "Tilt Left", key: "Steer Left", command: "Left" },
      { gesture: "Tilt Right", key: "Steer Right", command: "Right" },
      { gesture: "Closed Fist", key: "Boost", command: "Shift" },
      { gesture: "Open Palm", key: "Brake", command: "Space" },
    ],
  },
  {
    id: "caster",
    name: "Spellcaster Set",
    description: "Gesture combos for abilities, inventory, and quick actions.",
    mappings: [
      { gesture: "Circle Draw", key: "Special", command: "Q" },
      { gesture: "Two Fingers", key: "Inventory", command: "I" },
      { gesture: "Swipe Up", key: "Cast", command: "E" },
      { gesture: "Pinch Hold", key: "Aim", command: "Right Mouse" },
    ],
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

function StepTabs({ currentStep, onStepChange }) {
  return (
    <nav className="step-tabs" aria-label="Build steps">
      {["Upload Your Game", "Choose The Gesture", "Display"].map((label, index) => {
        const step = index + 1;

        return (
          <button
            className={`step-tab${currentStep === step ? " is-active" : ""}`}
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
  isDragging,
  onFileChange,
  onDrop,
  onDragStateChange,
  onReset,
  onNext,
  fileInputRef,
}) {
  const inputId = "game-file";
  const helperText = useMemo(() => {
    if (!selectedFile) {
      return "ZIP, EXE, HTML, WASM, ROM, or JS build";
    }

    return `${formatFileSize(selectedFile.size)} ready for gesture mapping`;
  }, [selectedFile]);

  return (
    <section className="upload-panel">
      <p className="eyebrow">Level 01</p>
      <h1 id="page-title">UPLOAD YOUR GAME</h1>
      <p className="intro">
        Drop in a game build and forge every keyboard action into a camera gesture.
      </p>

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
        <button className="pixel-button" type="button" onClick={onNext}>
          {selectedFile ? "Start Mapping" : "Continue"}
        </button>
        <button className="icon-button" type="button" aria-label="Open settings">
          <SettingsGlyph />
        </button>
      </div>
    </section>
  );
}

function ChooseGesturePanel({ selectedPresetId, onPresetChange, onBack, onNext }) {
  const [handPose, setHandPose] = useState({
    left: handPosePresets.fist,
    right: handPosePresets.fist,
  });

  function updateFinger(hand, id, value) {
    setHandPose((currentPose) => ({
      ...currentPose,
      [hand]: {
        ...currentPose[hand],
        [id]: value,
      },
    }));
  }

  function applyPose(hand, poseName) {
    setHandPose((currentPose) => ({
      ...currentPose,
      [hand]: handPosePresets[poseName],
    }));
  }

  function renderControlBoard(hand, label) {
    return (
      <div className="control-board" aria-label={`${label} finger control board`}>
        <div className="board-title">
          <span>{label}</span>
          <span className="mini-led">CONTROL</span>
        </div>

        <div className="pose-buttons" aria-label={`${label} quick hand poses`}>
          <button type="button" onClick={() => applyPose(hand, "open")}>
            Open
          </button>
          <button type="button" onClick={() => applyPose(hand, "fist")}>
            Fist
          </button>
          <button type="button" onClick={() => applyPose(hand, "peace")}>
            Peace
          </button>
        </div>

        <div className="finger-controls">
          {fingerControls.map((finger) => (
            <FingerSlider
              id={finger.id}
              key={finger.id}
              label={finger.label}
              value={handPose[hand][finger.id]}
              onChange={(id, value) => updateFinger(hand, id, value)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="stage-panel gesture-stage">
      <p className="eyebrow">Level 02</p>
      <h1 id="page-title">CHOOSE THE GESTURE</h1>
      <p className="intro">
        Pick the gesture language that will replace the game's keyboard controls.
      </p>

      <div className="gesture-lab">
        {renderControlBoard("left", "Left Hand")}
        <HandRig pose={handPose} />
        {renderControlBoard("right", "Right Hand")}
      </div>

      <div className="preset-grid" role="radiogroup" aria-label="Gesture presets">
        {gesturePresets.map((preset) => (
          <button
            className={`preset-card${selectedPresetId === preset.id ? " is-selected" : ""}`}
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={selectedPresetId === preset.id}
            onClick={() => onPresetChange(preset.id)}
          >
            <span className="preset-pixels" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <strong>{preset.name}</strong>
            <span>{preset.description}</span>
          </button>
        ))}
      </div>

      <div className="actions">
        <button className="pixel-button secondary" type="button" onClick={onBack}>
          Back
        </button>
        <button className="pixel-button" type="button" onClick={onNext}>
          Display
        </button>
      </div>
    </section>
  );
}

function DisplayPanel({ selectedFile, selectedPreset, onBack, onRestart }) {
  const fileName = selectedFile?.name ?? "Demo Game Build";

  return (
    <section className="stage-panel wide-panel">
      <p className="eyebrow">Level 03</p>
      <h1 id="page-title">DISPLAY</h1>
      <p className="intro">
        Your game is now shown with the selected gesture control layer.
      </p>

      <div className="display-grid">
        <div className="game-window" aria-label="Game display mockup">
          <div className="game-hud">
            <span>{fileName}</span>
            <span>GESTURE ON</span>
          </div>
          <div className="pixel-stage" aria-hidden="true">
            <span className="hero-sprite" />
            <span className="platform one" />
            <span className="platform two" />
            <span className="coin one" />
            <span className="coin two" />
            <span className="coin three" />
          </div>
        </div>

        <div className="summary-board">
          <div className="board-title">
            <span>{selectedPreset.name}</span>
            <span className="mini-led">ACTIVE</span>
          </div>
          {selectedPreset.mappings.map((mapping) => (
            <div className="mapping-row" key={`${mapping.gesture}-${mapping.command}`}>
              <span>{mapping.gesture}</span>
              <kbd>{mapping.command}</kbd>
            </div>
          ))}
        </div>
      </div>

      <div className="actions">
        <button className="pixel-button secondary" type="button" onClick={onBack}>
          Back
        </button>
        <button className="pixel-button" type="button" onClick={onRestart}>
          New Game
        </button>
      </div>
    </section>
  );
}

function GesturePreview({ selectedPreset }) {
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
        {selectedPreset.mappings.map((mapping) => (
          <div className="mapping-row" key={mapping.gesture}>
            <span>{mapping.gesture}</span>
            <kbd>{mapping.command}</kbd>
          </div>
        ))}
      </div>
    </aside>
  );
}

export default function App() {
  const fileInputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [selectedPresetId, setSelectedPresetId] = useState(gesturePresets[0].id);

  const selectedPreset = useMemo(
    () => gesturePresets.find((preset) => preset.id === selectedPresetId) ?? gesturePresets[0],
    [selectedPresetId],
  );

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

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleRestart() {
    handleReset();
    setSelectedPresetId(gesturePresets[0].id);
    setCurrentStep(1);
  }

  function renderStep() {
    if (currentStep === 2) {
      return (
        <ChooseGesturePanel
          selectedPresetId={selectedPresetId}
          onPresetChange={setSelectedPresetId}
          onBack={() => setCurrentStep(1)}
          onNext={() => setCurrentStep(3)}
        />
      );
    }

    if (currentStep === 3) {
      return (
        <DisplayPanel
          selectedFile={selectedFile}
          selectedPreset={selectedPreset}
          onBack={() => setCurrentStep(2)}
          onRestart={handleRestart}
        />
      );
    }

    return (
      <UploadPanel
        selectedFile={selectedFile}
        isDragging={isDragging}
        onFileChange={handleFileChange}
        onDrop={handleDrop}
        onDragStateChange={setIsDragging}
        onReset={handleReset}
        onNext={() => setCurrentStep(2)}
        fileInputRef={fileInputRef}
      />
    );
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

        <StepTabs currentStep={currentStep} onStepChange={setCurrentStep} />

        <div className={`hero-grid${currentStep === 2 ? " gesture-editor-grid" : ""}`}>
          {renderStep()}
          {currentStep !== 2 && <GesturePreview selectedPreset={selectedPreset} />}
        </div>
      </section>
    </main>
  );
}
