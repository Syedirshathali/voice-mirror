# Voice Mirror

Shadowing and delivery practice with your own ElevenLabs voice clone.
Two 30-day tracks: Voice, and Humour & Leadership.

Runs on a PC (local server) and on Android as an installable app. On Android, generated clips,
your recordings and your progress are stored in your Google Drive, not on the phone.

## On a PC

1. Install Python 3.8 or newer (python.org). Nothing else to install.
2. Windows: double-click `start.bat`. Mac: double-click `start.command`. Linux: `python3 server.py`.
3. First run asks for your ElevenLabs API key and saves it to `.env` in this folder.
4. Your browser opens the app. In **Settings**, click **Load** and pick your cloned voice.

Use headphones for Shadow mode.

## On Android (installable app, audio on Google Drive)

The app is a PWA: Chrome installs it like a normal app (own icon, full screen, works offline for the
app itself). The install is a few hundred KB. Audio never has to be stored on the phone.

### 1. Host the app (once)

A phone needs an HTTPS address for the microphone and for install. This repo is set up for GitHub
Pages (branch `main`, root folder). `.env` is gitignored, so your key is never published.
The app contains no secrets. Your ElevenLabs key is typed on the phone and stays in its browser storage.

### 2. Create a Google sign-in ID (once, about 5 minutes)

1. Go to https://console.cloud.google.com/ and create or pick a project.
2. **APIs & Services > Library**: enable **Google Drive API**.
3. **APIs & Services > OAuth consent screen**: choose External, fill in the app name and your email,
   and add your own Google account under **Test users**. (Test mode is fine for personal use.)
4. **APIs & Services > Credentials > Create credentials > OAuth client ID**, type **Web application**.
   Under **Authorized JavaScript origins** add your app's address, for example `https://yourname.github.io`
   (origin only, no path).
5. Copy the client ID (`...apps.googleusercontent.com`). It is not a secret.

The app asks only for the `drive.file` permission: it can see and edit only the files it created,
inside a folder called **Voice Mirror**. It cannot read the rest of your Drive.

### 3. Install and connect on the phone

1. Open the app address in Chrome on Android, then menu > **Install app** (or **Add to Home screen**).
2. Open it, go to **Settings**, paste your ElevenLabs key, tap **Load** and pick your voice.
3. Paste the Google client ID, tap **Connect Google Drive**, and sign in.
   (Or put the client ID in `config.js` before hosting, so you do not have to type it.)

From then on every generated clip and recording is uploaded to Drive, and progress syncs between devices.
Replaying a clip downloads it from Drive and costs no ElevenLabs credits.

If the sign-in pop-up is blocked after a restart, a banner says "Google Drive needs you to sign in".
Tap it. While Drive cannot be reached, the app will not generate new clips, so it never spends
credits on audio that may already be saved.

### Moving what is already on a PC

On the PC, open Settings, connect Google Drive, and tap **Move audio on this device to Drive**.
Clips and recordings go up to Drive and are removed from that browser. The phone then finds them
instead of paying to generate them again.

## How it works

- `server.py` serves the app on `http://127.0.0.1:8765` and forwards speech requests to ElevenLabs with
  the key from `.env`. It only accepts connections from this computer.
- On Android there is no server: the app calls ElevenLabs directly with the key you typed in Settings.
- Clips are saved by a hash of (model, voice, stability, text) so the same sentence is never paid for twice.
- Drive folder contents: `tts-<hash>.mp3` (the sentence is in the file description), `take-<id>.webm`
  (Day 1 / Day 30 recordings), `progress.json`.
- Progress from two devices is merged: take counts and best scores keep the higher value, "nailed" stays set.

## Files

- `index.html`: the app
- `drive.js`: Google Drive storage
- `config.js`: optional default Google client ID
- `sw.js`, `manifest.webmanifest`, `icons/`: make it installable on Android
- `server.py`: local server for PC, Python standard library only
- `.env`: your key (created on first run; keep it private)
