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
