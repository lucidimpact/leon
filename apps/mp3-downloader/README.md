# MP3 Downloader

A small local web app that pulls the audio out of an online video and saves it as an MP3.

It is a dependency-free Node server (no `npm install` needed) wrapping
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and [`ffmpeg`](https://ffmpeg.org/), with a browser UI
for pasting links and watching progress.

## Requirements

| Tool     | Install                                                                    |
| -------- | -------------------------------------------------------------------------- |
| Node 18+ | already required by this repository                                        |
| yt-dlp   | `pip install -U yt-dlp` (or `brew install yt-dlp`)                         |
| ffmpeg   | `brew install ffmpeg` · `sudo apt install ffmpeg` · `choco install ffmpeg` |

The app checks for both at startup and tells you in the UI if one is missing.

## Run it

```bash
node apps/mp3-downloader/server.js
```

Then open <http://127.0.0.1:4545>.

Paste a video URL, pick a bitrate, hit **Download MP3**. Progress streams live; when a job is done
the file is already on disk and **Save file** hands you a copy through the browser.

## Configuration

All optional, via environment variables:

| Variable                | Default                      | Purpose                             |
| ----------------------- | ---------------------------- | ----------------------------------- |
| `MP3_DL_PORT`           | `4545`                       | HTTP port                           |
| `MP3_DL_HOST`           | `127.0.0.1`                  | Bind address (localhost by default) |
| `MP3_DL_OUTPUT_DIR`     | `~/Downloads/mp3-downloader` | Where MP3s are written              |
| `MP3_DL_MAX_CONCURRENT` | `2`                          | Parallel downloads                  |
| `MP3_DL_YT_DLP_BIN`     | `yt-dlp`                     | Path to the yt-dlp binary           |
| `MP3_DL_FFMPEG_BIN`     | `ffmpeg`                     | Path to the ffmpeg binary           |

Example:

```bash
MP3_DL_PORT=8080 MP3_DL_OUTPUT_DIR=~/Music/rips node apps/mp3-downloader/server.js
```

## HTTP API

The UI is built on a small JSON API, usable on its own:

| Method | Route                  | Description                                   |
| ------ | ---------------------- | --------------------------------------------- |
| `GET`  | `/api/health`          | yt-dlp / ffmpeg availability and output dir   |
| `GET`  | `/api/jobs`            | All jobs from this process, newest first      |
| `POST` | `/api/jobs`            | `{ "url": "…", "quality": "192K" }` → new job |
| `GET`  | `/api/jobs/:id`        | One job's current state                       |
| `GET`  | `/api/jobs/:id/events` | Server-sent events progress stream            |
| `GET`  | `/api/jobs/:id/file`   | The finished MP3                              |
| `POST` | `/api/jobs/:id/cancel` | Stop a queued or running job                  |

```bash
curl -X POST http://127.0.0.1:4545/api/jobs \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/watch?v=…","quality":"320K"}'
```

## Notes

- The server binds to `127.0.0.1`, so it is reachable only from your machine. Change `MP3_DL_HOST`
  only if you understand what you are exposing — there is no authentication.
- Job history lives in memory and resets when the server restarts; the MP3 files themselves stay in
  the output directory.
- Only download material you hold the rights to, or that is licensed for it.
