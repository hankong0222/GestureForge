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

## Composio Game Control Analysis

Start the backend that receives GitHub URLs or zip uploads, creates session
folders, runs analysis, and serves the session game folder:

```powershell
npm run backend
```

By default the backend skips generated/UI-heavy folders, ranks likely input
files first, and sends only a small evidence set to the agent to avoid TPM
limits: `ANALYZER_MODEL=gpt-4o-mini`, `ANALYZER_MAX_FILES=50`,
`ANALYZER_MAX_EVIDENCE=25`, and `ANALYZER_MAX_CONTEXT_LINES=1`.

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
`analysis.json`, accepts `mapping.json`, and serves the game at:

```text
http://localhost:8787/api/sessions/<session_id>/game/
```

Analyze a game's source code and extract keyboard controls:

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

The script first scans source files for keyboard input evidence, then sends the
evidence to a Composio-backed OpenAI Agent and returns a control manifest. Each
control is shaped for the next GestureForge step: show it to the user, let the
user select controls, then replace selected keyboard checks with GestureForge
control functions.

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
