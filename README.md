# GestureForge

## MediaPipe Hand Skeleton

Your current `venv` points to a missing Python install. If it fails to run, install Python 3.12 and rebuild it first:

```powershell
Remove-Item -Recurse -Force venv
python -m venv venv
venv\Scripts\python.exe -m pip install --upgrade pip
venv\Scripts\python.exe -m pip install -r requirements.txt
```

Open the webcam and draw MediaPipe hand skeleton lines:

```powershell
venv\Scripts\python.exe tools\live_hand_skeleton.py --mirror
```

Controls:

```text
q or Esc  close the camera window
s         save a screenshot to runs/hand_skeleton
```

## Local Game Control Analysis

Start the backend that receives GitHub URLs or zip uploads, creates session
folders, runs analysis, and serves the session game folder:

```powershell
npm run backend
```

By default the backend runs the local keyboard evidence scanner, skips
generated/UI-heavy folders, and keeps the scan bounded with:
`ANALYZER_MAX_FILES=50`, `ANALYZER_MAX_EVIDENCE=25`, and
`ANALYZER_MAX_CONTEXT_LINES=1`.

Check it is running:

```powershell
Invoke-RestMethod http://localhost:8787/api/health
```

Or use the helper scripts:

```powershell
.\scripts\start_backend.ps1
.\scripts\test_github_session.ps1 -GithubUrl "https://github.com/OWNER/REPO"
.\scripts\test_zip_session.ps1 -ZipPath "path\to\game.zip"
.\scripts\collect_keyboard_evidence.ps1 -Source "tmp\sessions\<session_id>\original"
```

For very large repositories, lower the analyzer limits:

```powershell
.\scripts\start_backend.ps1 -Model gpt-4o-mini -MaxFiles 50 -MaxEvidence 25
```

If PowerShell blocks local scripts, run them through `-ExecutionPolicy Bypass`:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts\test_github_session.ps1 -GithubUrl "https://github.com/OWNER/REPO"
```

Create a session from a GitHub repository:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:8787/api/sessions/github `
  -ContentType application/json `
  -Body '{"github_url":"https://github.com/OWNER/REPO"}'
```

Poll the session until `status` becomes `ready`:

```powershell
Invoke-RestMethod http://localhost:8787/api/sessions/<session_id>
```

Then fetch the keyboard analysis:

```powershell
Invoke-RestMethod http://localhost:8787/api/sessions/<session_id>/analysis
```

The backend clones into `tmp/sessions/<session_id>/original`, writes
`analysis.json`, accepts `mapping.json`, applies selected mappings into
`patched`, and serves the patched game when it exists:

```text
http://localhost:8787/api/sessions/<session_id>/game/
```

After saving a mapping, generate a line-level patch plan with:

```powershell
Invoke-RestMethod -Method Post http://localhost:8787/api/sessions/<session_id>/plan-mapping
Invoke-RestMethod http://localhost:8787/api/sessions/<session_id>/patch-plan
```

The plan does not modify source files. It lists exact `file`, `line`,
`before`, and `after` values for the user to review. Planned replacements wrap
the original keyboard predicate and pass it into `gestureForge.input.check`, so
keyboard behavior is preserved while gesture predicates are composed in:

```js
if (gestureForge.input.check("jump", function gestureForgeOriginalPredicate() {
  return me.input.isKeyPressed("jump");
})) {
```

After user approval, apply it manually with:

```powershell
Invoke-RestMethod -Method Post http://localhost:8787/api/sessions/<session_id>/apply-mapping
Invoke-RestMethod http://localhost:8787/api/sessions/<session_id>/patch-report
```

`apply-mapping` uses `patch-plan.json` when it exists. Each patch is applied
only when `confidence >= 0.8`, the patch is not marked `"approved": false`, and
the reviewed `before` text exactly matches the current source line. Mismatches
are left unchanged and reported as `manual_review`.

The planner and patcher are conservative. Unsupported languages or ambiguous
targets are kept in `manual_review`; those are the cases where an AI-assisted
planner or an engine-specific planner is needed.

Analyze a game's source code and extract keyboard controls:

```powershell
python tools\analyze_game_controls_local.py --source path\to\game --json-out runs\controls.json
```

To inspect only the local keyboard evidence:

```powershell
python tools\analyze_game_controls_local.py --source path\to\game --collect-only
```

The script scans source files for keyboard input evidence and returns a control
manifest. Each control is shaped for the next GestureForge step: show it to the
user, let the user select controls, then replace selected keyboard checks with
GestureForge control functions.

<!--
Legacy Composio analyzer notes, kept disabled because the current local flow
must not create a Composio session:

```powershell
python -m pip install composio composio-openai-agents openai-agents
Copy-Item .env.example .env
# Edit .env and fill in COMPOSIO_API_KEY and OPENAI_API_KEY.
python tools\analyze_game_controls_with_composio.py --source path\to\game --json-out runs\controls.json
```

You can also set keys only for the current PowerShell session:

```powershell
$env:COMPOSIO_API_KEY="your_composio_key"
$env:OPENAI_API_KEY="your_openai_key"
```

To inspect only the local keyboard evidence before calling Composio:

```powershell
python tools\analyze_game_controls_with_composio.py --source path\to\game --collect-only
```
-->

## Cloudinary Recording + AI Video Analysis

Recordings are uploaded directly from the browser to Cloudinary as original
video files. The backend receives the returned `video_url` and `public_id`, then
starts an async AI analysis job:

```text
Cloudinary original video
  -> backend stores video_url/public_id
  -> Whisper transcript
  -> local audio event detection for high volume, scream-like, and laughter-like bursts
  -> sampled frames + transcript + audio events sent to Backboard
  -> Backboard memory applies saved user highlight preferences
  -> funny highlight windows saved to tmp/recordings/<recording_id>/analysis.json
```

Required local configuration:

```powershell
Copy-Item .env.example .env
# Fill OPENAI_API_KEY, VITE_CLOUDINARY_CLOUD_NAME, and VITE_CLOUDINARY_UPLOAD_PRESET.
# Fill BACKBOARD_API_KEY for multimodal funny moment judgment and preference memory.
# Fill CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET for server-side MP4 rendering.
venv\Scripts\python.exe -m pip install -r requirements.txt
```

`ffmpeg` must be available on `PATH`, or set `FFMPEG` in `.env`.

Relevant model defaults:

```env
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
CLOUDINARY_RENDER_FOLDER=gestureforge-renders
CLOUDINARY_ASSET_FOLDER=gestureforge-renders/assets
OPENAI_TRANSCRIBE_MODEL=whisper-1
BACKBOARD_API_KEY=your_backboard_api_key
BACKBOARD_LLM_PROVIDER=openai
BACKBOARD_MODEL_NAME=gpt-4o
BACKBOARD_MEMORY_MODE=Readonly
BACKBOARD_ANALYSIS_MEMORY_MODE=Readonly
```

Level 04 includes a feedback area where users can write a preferred analysis
prompt and feedback on the current highlights. Submitting it calls
`POST /api/recordings/<recording_id>/feedback`, stores the preference through
Backboard memory, and re-runs the multimodal highlight selection.

Recording metadata endpoint:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:8787/api/recordings/cloudinary `
  -ContentType application/json `
  -Body '{"public_id":"gestureforge/demo","video_url":"https://res.cloudinary.com/.../video/upload/demo.webm"}'
```

Poll analysis:

```powershell
Invoke-RestMethod http://localhost:8787/api/recordings/<recording_id>
Invoke-RestMethod http://localhost:8787/api/recordings/<recording_id>/analysis
```

Generate the Cloudinary edit plan after analysis:

```powershell
Invoke-RestMethod http://localhost:8787/api/recordings/<recording_id>/clip-plan
Invoke-RestMethod -Method Post http://localhost:8787/api/recordings/<recording_id>/clip-plan/regenerate
```

The generated plan contains trim windows, 9:16 crop settings, splice order,
caption segments, meme/title overlays, local meme/sound asset choices, and
zoom/freeze-frame suggestions.

Render the edited Cloudinary MP4 from the current plan:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:8787/api/recordings/<recording_id>/render `
  -ContentType application/json `
  -Body '{"plan":null}'
Invoke-RestMethod http://localhost:8787/api/recordings/<recording_id>/render
```

Rendering first syncs only the allowed local `asset` catalog into your
Cloudinary account, builds each trimmed/cropped/overlaid clip, uploads those
derived clips, splices them into a final MP4, and writes the manifest to
`tmp/recordings/<recording_id>/clip-render.json`. Level 04 can also send a
manually tuned plan body with updated trim times, title text, and meme/sound
choices before rendering.

The asset policy is intentionally locked down: clip plans may only reference
the local `asset` catalog. Current allowed IDs are `meme_laugh`,
`meme_embarrassed`, `sound_laugh`, and `sound_wtf`.

Apply user feedback and re-run analysis:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:8787/api/recordings/<recording_id>/feedback `
  -ContentType application/json `
  -Body '{"prompt":"Prefer short absurd fail clips.","feedback":"Score loud reactions higher next time."}'
```

```json
{
  "controls": [
    {
      "id": "ctrl_jump_space",
      "key": "Space",
      "code": "Space",
      "action": "Jump",
      "event": "keydown",
      "source_kind": "event_listener",
      "binding_target": {
        "file": "src/game.js",
        "line": 42,
        "text": "me.input.bindKey(me.input.KEY.SPACE, \"jump\", true);"
      },
      "usage_targets": [
        {
          "file": "src/player.js",
          "line": 80,
          "text": "if (me.input.isKeyPressed(\"jump\")) {"
        }
      ],
      "replacement_strategy": "replace_usage_check_with_gesture_function",
      "suggested_function": "gestureForge.controls.jump()",
      "confidence": 0.92,
      "evidence": [{ "file": "src/game.js", "line": 42, "text": "if (e.code === 'Space') jump();" }]
    }
  ],
  "unresolved": []
}
```
