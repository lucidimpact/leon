# MP3 Downloader

A small local web app that pulls the audio out of an online video and saves it as an MP3.

It is a dependency-free Node server (no `npm install` needed) wrapping
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and [`ffmpeg`](https://ffmpeg.org/), with a browser UI
for pasting links and watching progress. This folder is self-contained — copy it anywhere on your
machine and it runs on its own.

## Install

Three one-time steps.

**1. Node 18 or newer.** Check with `node -v`. If it is missing, get it from
<https://nodejs.org>, or `brew install node` / `sudo apt install nodejs`.

**2. yt-dlp** — this is what talks to the video sites.

```bash
pip install -U yt-dlp        # any OS with Python
brew install yt-dlp          # macOS
```

**3. ffmpeg** — this is what converts the audio to MP3.

```bash
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Debian / Ubuntu
choco install ffmpeg         # Windows
```

The app checks for yt-dlp and ffmpeg at startup and says so in the page if either is missing.

## Use

```bash
node apps/mp3-downloader/server.js
```

On a Mac you can skip the terminal entirely: double-click **start.command** inside this folder.

Either way it prints the address and opens <http://127.0.0.1:4545> in your browser.

1. Paste the video URL.
2. Pick a bitrate — 192 kbps is the default and is fine for most things.
3. Press **Download MP3**.

Progress runs live in the page. Once a row says **Ready**, the MP3 is already saved to
`~/Downloads/mp3-downloader`; **Save file** just hands you another copy through the browser. Stop
the server with `Ctrl+C`.

## Transcripts

Tick **Also save a transcript** before starting a download and you get two files in the same folder,
under the same name: `Some Video.mp3` and `Some Video.txt`. Already downloaded something? Its row
has a **Transcribe** button that does the same thing after the fact.

This needs a Whisper command-line tool. Either of these works and is picked up automatically:

```bash
pip install -U openai-whisper          # the reference implementation
pip install -U whisper-ctranslate2     # faster-whisper; quicker on a CPU
```

Until one is installed, the checkbox stays disabled and says so. The first run downloads the model
(a few hundred MB) and is slower than the ones after it.

It transcribes English by default, using the `base.en` model. Those `.en` models are trained on
English alone and read it better than the general ones, and naming the language up front skips the
detection pass.

For another language, name a general model and that language:

```bash
MP3_DL_WHISPER_MODEL=base MP3_DL_WHISPER_LANGUAGE=fr node apps/mp3-downloader/server.js
```

Model sizes run `tiny`, `base`, `small`, `medium`, `large` — bigger is more accurate and slower.

A failed transcript never costs you the audio: the MP3 stays, and the row says what went wrong.

## When downloads start failing

Video sites change their players, and yt-dlp is the part that keeps up with them. When that is what
broke, the app handles it without a terminal:

- **Fix download process** — the button in the Troubleshooting card updates yt-dlp in place. It
  works out how yt-dlp was installed (it reads the shebang of the `yt-dlp` on your `PATH`) and uses
  the matching route: `python -m pip install -U yt-dlp` for a pip install, `yt-dlp -U` for a
  standalone binary. If the detected route fails, it tries the other one and shows you the raw
  output either way.
- **Try again** — appears on any failed row and re-runs that same URL, so the fix-then-retry loop
  is two clicks.

Homebrew installs are handled automatically — the button runs `brew upgrade yt-dlp` when it sees
yt-dlp came from Homebrew. For anything else it cannot work out, such as pipx, name the command:

```bash
MP3_DL_UPDATE_CMD="brew upgrade yt-dlp" node apps/mp3-downloader/server.js
```

## Configuration

All optional, via environment variables:

| Variable                    | Default                      | Purpose                                 |
| --------------------------- | ---------------------------- | --------------------------------------- |
| `MP3_DL_PORT`               | `4545`                       | HTTP port                               |
| `MP3_DL_HOST`               | `127.0.0.1`                  | Bind address (localhost by default)     |
| `MP3_DL_OUTPUT_DIR`         | `~/Downloads/mp3-downloader` | Where MP3s are written                  |
| `MP3_DL_MAX_CONCURRENT`     | `2`                          | Parallel downloads                      |
| `MP3_DL_OPEN`               | `1`                          | Set to `0` to not open the browser      |
| `MP3_DL_YT_DLP_BIN`         | `yt-dlp`                     | Path to the yt-dlp binary               |
| `MP3_DL_FFMPEG_BIN`         | `ffmpeg`                     | Path to the ffmpeg binary               |
| `MP3_DL_UPDATE_CMD`         | auto-detected                | Command behind **Fix download process** |
| `MP3_DL_WHISPER_BIN`        | auto-detected                | Path to the Whisper binary              |
| `MP3_DL_WHISPER_MODEL`      | `base.en`                    | Whisper model size                      |
| `MP3_DL_WHISPER_LANGUAGE`   | `en`                         | Spoken language, e.g. `fr`              |
| `MP3_DL_TRANSCRIBE_TIMEOUT` | `1800`                       | Transcription timeout, in seconds       |

Example:

```bash
MP3_DL_PORT=8080 MP3_DL_OUTPUT_DIR=~/Music/rips node apps/mp3-downloader/server.js
```

## HTTP API

The UI is built on a small JSON API, usable on its own:

| Method | Route                      | Description                                   |
| ------ | -------------------------- | --------------------------------------------- |
| `GET`  | `/api/health`              | yt-dlp / ffmpeg availability and output dir   |
| `GET`  | `/api/jobs`                | All jobs from this process, newest first      |
| `POST` | `/api/jobs`                | `{ "url": "…", "quality": "192K" }` → new job |
| `GET`  | `/api/jobs/:id`            | One job's current state                       |
| `GET`  | `/api/jobs/:id/events`     | Server-sent events progress stream            |
| `GET`  | `/api/jobs/:id/file`       | The finished MP3                              |
| `POST` | `/api/jobs/:id/cancel`     | Stop a queued or running job                  |
| `GET`  | `/api/jobs/:id/transcript` | The finished transcript                       |
| `POST` | `/api/jobs/:id/retry`      | Re-run the same URL as a new job              |
| `POST` | `/api/jobs/:id/transcribe` | Transcribe a finished download                |
| `GET`  | `/api/update-yt-dlp`       | State of the last yt-dlp update               |
| `POST` | `/api/update-yt-dlp`       | Update yt-dlp, returning the command output   |

```bash
curl -X POST http://127.0.0.1:4545/api/jobs \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/watch?v=…","quality":"320K","transcribe":true}'
```

## Notes

- The server binds to `127.0.0.1`, so it is reachable only from your machine. Change `MP3_DL_HOST`
  only if you understand what you are exposing — there is no authentication.
- Job history lives in memory and resets when the server restarts; the MP3 and transcript files
  themselves stay in the output directory.
- Both files always land together in `MP3_DL_OUTPUT_DIR` — that one setting moves both.
- Only download material you hold the rights to, or that is licensed for it.
