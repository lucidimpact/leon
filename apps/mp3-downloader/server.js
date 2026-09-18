#!/usr/bin/env node

/**
 * MP3 Downloader — a small local web app that extracts MP3 audio from
 * online videos.
 *
 * It is a thin, dependency-free wrapper around yt-dlp + ffmpeg: this server
 * spawns yt-dlp, streams its progress to the browser over SSE, and serves the
 * resulting file back for download.
 *
 * Run: node apps/mp3-downloader/server.js
 */

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

/* ========== CONFIGURATION ========== */

const HOST = process.env.MP3_DL_HOST || '127.0.0.1'
const PORT = Number(process.env.MP3_DL_PORT || 4545)
const DOWNLOAD_DIR =
  process.env.MP3_DL_OUTPUT_DIR ||
  path.join(os.homedir(), 'Downloads', 'mp3-downloader')
const MAX_CONCURRENT_JOBS = Number(process.env.MP3_DL_MAX_CONCURRENT || 2)
const OPEN_BROWSER = process.env.MP3_DL_OPEN !== '0'
const YT_DLP_BIN = process.env.MP3_DL_YT_DLP_BIN || 'yt-dlp'
const FFMPEG_BIN = process.env.MP3_DL_FFMPEG_BIN || 'ffmpeg'
// Transcription. The binary is auto-detected unless one is named here.
const WHISPER_BIN = process.env.MP3_DL_WHISPER_BIN || ''
// English by default: the `.en` models are trained on English alone and read it
// better, and naming the language skips the detection pass. Both are
// overridable for other languages, e.g. MODEL=base LANGUAGE=fr.
const WHISPER_MODEL = process.env.MP3_DL_WHISPER_MODEL || 'base.en'
const WHISPER_LANGUAGE = process.env.MP3_DL_WHISPER_LANGUAGE || 'en'
const TRANSCRIBE_TIMEOUT =
  Number(process.env.MP3_DL_TRANSCRIBE_TIMEOUT || 1800) * 1000
// Escape hatch for installs this app cannot work out on its own, e.g.
// MP3_DL_UPDATE_CMD="brew upgrade yt-dlp" or "pipx upgrade yt-dlp".
const UPDATE_CMD = process.env.MP3_DL_UPDATE_CMD || ''
const PUBLIC_DIR = path.join(__dirname, 'public')

/**
 * yt-dlp audio quality: 0 is best VBR, 9 is worst. Fixed bitrates are also
 * accepted (e.g. '192K'), which is what the UI sends.
 */
const ALLOWED_QUALITIES = ['320K', '256K', '192K', '128K', '96K', '0']
const DEFAULT_QUALITY = '192K'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg'
}

/* ========== END CONFIGURATION ========== */

/* ========== JOB STATE ========== */

/**
 * jobId -> job. Jobs live in memory only; the produced MP3 files live on disk
 * and outlive the process.
 */
const jobs = new Map()
const queue = []
let runningCount = 0

function createJob(url, quality, transcribe = false) {
  const job = {
    id: crypto.randomUUID(),
    url,
    quality,
    transcribe,
    status: 'queued', // queued | downloading | converting | done | error | cancelled
    title: '',
    percent: 0,
    speed: '',
    eta: '',
    message: 'Waiting for a free slot…',
    fileName: '',
    filePath: '',
    fileSize: 0,
    transcriptFileName: '',
    transcriptPath: '',
    transcribing: false,
    createdAt: Date.now(),
    finishedAt: 0,
    settled: false,
    dir: path.join(DOWNLOAD_DIR, '.jobs', ''),
    child: null,
    listeners: new Set(),
    log: []
  }

  job.dir = path.join(DOWNLOAD_DIR, `.job-${job.id}`)
  jobs.set(job.id, job)

  return job
}

/** Everything the browser is allowed to see about a job. */
function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    quality: job.quality,
    transcribe: job.transcribe,
    status: job.status,
    title: job.title,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    message: job.message,
    fileName: job.fileName,
    fileSize: job.fileSize,
    transcriptFileName: job.transcriptFileName,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  }
}

function updateJob(job, patch) {
  Object.assign(job, patch)

  const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`

  for (const res of job.listeners) {
    res.write(payload)
  }
}

function closeJobStreams(job) {
  for (const res of job.listeners) {
    res.write('event: end\ndata: {}\n\n')
    res.end()
  }

  job.listeners.clear()
}

/* ========== END JOB STATE ========== */

/* ========== YT-DLP EXECUTION ========== */

/**
 * yt-dlp emits one progress line per update with --newline, e.g.
 * "[download]   4.2% of   10.00MiB at    1.00MiB/s ETA 00:09"
 */
const DOWNLOAD_PROGRESS_REGEX =
  /^\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*([\d.]+\w+))?(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/
const TITLE_REGEX = /^\[title\]\s+(.+)$/

function parseProgressLine(job, rawLine) {
  const line = rawLine.trim()

  if (!line) {
    return
  }

  job.log.push(line)

  if (job.log.length > 200) {
    job.log.shift()
  }

  const titleMatch = line.match(TITLE_REGEX)

  if (titleMatch) {
    updateJob(job, { title: titleMatch[1] })

    return
  }

  const progressMatch = line.match(DOWNLOAD_PROGRESS_REGEX)

  if (progressMatch) {
    updateJob(job, {
      status: 'downloading',
      percent: Number(progressMatch[1]),
      speed: progressMatch[3] || '',
      eta: progressMatch[4] || '',
      message: 'Downloading audio stream…'
    })

    return
  }

  if (line.startsWith('[ExtractAudio]') || line.startsWith('[Merger]')) {
    updateJob(job, {
      status: 'converting',
      percent: 100,
      speed: '',
      eta: '',
      message: 'Converting to MP3…'
    })
  }
}

function buildYtDlpArgs(job) {
  const args = [
    '--extract-audio',
    '--audio-format',
    'mp3',
    '--audio-quality',
    job.quality,
    '--embed-thumbnail',
    '--embed-metadata',
    '--no-playlist',
    '--no-color',
    '--newline',
    '--no-warnings',
    '--print',
    'before_dl:[title] %(title)s',
    '--output',
    path.join(job.dir, '%(title).180B.%(ext)s')
  ]

  // `--ffmpeg-location` takes a path, so passing the bare default name would
  // break yt-dlp's own PATH lookup. Only forward an explicitly configured one.
  if (FFMPEG_BIN !== 'ffmpeg') {
    args.push('--ffmpeg-location', FFMPEG_BIN)
  }

  // `--` stops yt-dlp from reading a URL that begins with `-` as a flag.
  args.push('--', job.url)

  return args
}

/** Picks the MP3 yt-dlp produced and moves it out of the per-job directory. */
async function collectResult(job) {
  const entries = await fsp.readdir(job.dir)
  const mp3 = entries.find((entry) => entry.toLowerCase().endsWith('.mp3'))

  if (!mp3) {
    throw new Error('yt-dlp finished but produced no MP3 file')
  }

  let target = path.join(DOWNLOAD_DIR, mp3)
  let counter = 1

  while (fs.existsSync(target)) {
    const ext = path.extname(mp3)
    target = path.join(
      DOWNLOAD_DIR,
      `${path.basename(mp3, ext)} (${counter})${ext}`
    )
    counter += 1
  }

  await fsp.rename(path.join(job.dir, mp3), target)
  await fsp.rm(job.dir, { recursive: true, force: true })

  const stats = await fsp.stat(target)

  return {
    fileName: path.basename(target),
    filePath: target,
    fileSize: stats.size
  }
}

async function runJob(job) {
  runningCount += 1

  try {
    await fsp.mkdir(job.dir, { recursive: true })
  } catch (error) {
    finishJob(job, {
      status: 'error',
      message: `Cannot create download directory: ${error.message}`
    })

    return
  }

  updateJob(job, { status: 'downloading', message: 'Starting yt-dlp…' })

  const child = spawn(YT_DLP_BIN, buildYtDlpArgs(job), {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  job.child = child

  let stdoutBuffer = ''
  let stderrTail = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk

    const lines = stdoutBuffer.split(/\r?\n|\r/)

    stdoutBuffer = lines.pop() || ''

    for (const line of lines) {
      parseProgressLine(job, line)
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2000)
  })

  child.on('error', (error) => {
    const message =
      error.code === 'ENOENT'
        ? `yt-dlp not found (looked for "${YT_DLP_BIN}"). See the README for install steps.`
        : error.message

    finishJob(job, { status: 'error', message })
  })

  child.on('close', async (code, signal) => {
    job.child = null

    if (job.status === 'cancelled') {
      await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {})
      finishJob(job, { status: 'cancelled', message: 'Cancelled' })

      return
    }

    if (code !== 0) {
      await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {})

      const reason =
        stderrTail.trim().split('\n').pop() ||
        `yt-dlp exited with code ${code || signal}`

      finishJob(job, { status: 'error', message: reason })

      return
    }

    try {
      const result = await collectResult(job)

      updateJob(job, {
        percent: 100,
        title: job.title || path.basename(result.fileName, '.mp3'),
        ...result
      })

      if (!job.transcribe) {
        finishJob(job, { status: 'done', message: 'Ready' })

        return
      }

      updateJob(job, { status: 'transcribing', message: 'Transcribing audio…' })

      const transcript = await transcribeFile(job)

      if (!transcript.ok) {
        // The MP3 is already on disk, so a failed transcript is not a failed job.
        finishJob(job, {
          status: 'done',
          message: `Audio ready. Transcription failed: ${transcript.error}`
        })

        return
      }

      finishJob(job, {
        status: 'done',
        message: 'Audio and transcript ready',
        transcriptFileName: transcript.fileName,
        transcriptPath: transcript.filePath
      })
    } catch (error) {
      finishJob(job, { status: 'error', message: error.message })
    }
  })
}

function finishJob(job, patch) {
  // A failed spawn emits both `error` and `close`; only the first one counts.
  if (job.settled) {
    return
  }

  job.settled = true

  updateJob(job, { ...patch, finishedAt: Date.now(), speed: '', eta: '' })
  closeJobStreams(job)

  runningCount = Math.max(0, runningCount - 1)
  drainQueue()
}

function drainQueue() {
  while (runningCount < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const job = queue.shift()

    if (job.status === 'queued') {
      runJob(job)
    }
  }
}

function enqueueJob(job) {
  queue.push(job)
  drainQueue()
}

/* ========== END YT-DLP EXECUTION ========== */

/* ========== DEPENDENCY CHECK ========== */

function checkBinary(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let output = ''

    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', () => resolve({ available: false, version: '' }))
    child.on('close', (code) =>
      resolve({
        available: code === 0,
        version: output.trim().split('\n')[0] || ''
      })
    )
  })
}

async function readHealth() {
  const [ytDlp, ffmpeg, whisperBin] = await Promise.all([
    checkBinary(YT_DLP_BIN, ['--version']),
    checkBinary(FFMPEG_BIN, ['-version']),
    detectWhisper()
  ])

  return {
    ytDlp,
    ffmpeg,
    whisper: {
      available: Boolean(whisperBin),
      // A configured binary can be a long absolute path; the page wants a name.
      bin: path.basename(whisperBin),
      model: WHISPER_MODEL
    },
    outputDir: DOWNLOAD_DIR
  }
}

/* ========== END DEPENDENCY CHECK ========== */

/* ========== YT-DLP MAINTENANCE ========== */

/**
 * yt-dlp is the piece that breaks when a video site changes its player, so the
 * UI offers a one-click update. Only one update runs at a time and the raw
 * output is kept so the page can show exactly what happened.
 */
const updateState = {
  running: false,
  ok: null,
  command: '',
  output: '',
  message: '',
  versionBefore: '',
  versionAfter: '',
  finishedAt: 0
}

function publicUpdateState() {
  return { ...updateState }
}

/** Runs a command to completion and returns its exit code plus merged output. */
function runCommand(bin, args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    let child

    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, output: error.message })

      return
    }

    let output = ''
    const timer = setTimeout(() => {
      output += '\n\nTimed out.'
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, output: `${output}${error.message}`.trim() })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code === null ? -1 : code, output: output.trim() })
    })
  })
}

/**
 * A pip-installed yt-dlp is a Python script whose shebang names the exact
 * interpreter that owns it — which is the one that can upgrade it. A standalone
 * binary has no such shebang and updates itself with `-U` instead.
 */
async function readPipInterpreter() {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  const resolved = await runCommand(locator, [YT_DLP_BIN], 10_000)

  if (resolved.code !== 0) {
    return ''
  }

  const binPath = resolved.output.split('\n')[0].trim()

  try {
    const handle = await fsp.open(binPath, 'r')
    const buffer = Buffer.alloc(256)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)

    await handle.close()

    const shebang = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .split('\n')[0]

    if (shebang.startsWith('#!') && shebang.includes('python')) {
      const tokens = shebang.slice(2).trim().split(/\s+/)

      // `#!/usr/bin/env python3` points at the interpreter with its second token.
      return tokens[0].endsWith('env') && tokens[1] ? tokens[1] : tokens[0]
    }
  } catch {
    // Unreadable, or a real binary: fall through to the self-update path.
  }

  return ''
}

async function resolveUpdateCommand() {
  if (UPDATE_CMD) {
    const tokens = UPDATE_CMD.split(' ').filter(Boolean)

    return { bin: tokens[0], args: tokens.slice(1), kind: 'custom' }
  }

  const interpreter = await readPipInterpreter()

  if (interpreter) {
    return {
      bin: interpreter,
      args: ['-m', 'pip', 'install', '-U', 'yt-dlp'],
      kind: 'pip'
    }
  }

  return { bin: YT_DLP_BIN, args: ['-U'], kind: 'self' }
}

async function runYtDlpUpdate() {
  updateState.running = true
  updateState.ok = null
  updateState.message = 'Updating yt-dlp…'
  updateState.output = ''

  const before = await checkBinary(YT_DLP_BIN, ['--version'])
  const primary = await resolveUpdateCommand()

  updateState.command = [primary.bin, ...primary.args].join(' ')
  updateState.versionBefore = before.version

  let result = await runCommand(primary.bin, primary.args)

  // pip installs cannot self-update and standalone binaries have no pip, so if
  // the detected route fails, try the other one before giving up.
  if (result.code !== 0 && primary.kind !== 'custom') {
    const fallback =
      primary.kind === 'pip'
        ? { bin: YT_DLP_BIN, args: ['-U'] }
        : { bin: 'python3', args: ['-m', 'pip', 'install', '-U', 'yt-dlp'] }
    const fallbackResult = await runCommand(fallback.bin, fallback.args)

    result = {
      code: fallbackResult.code,
      output: `$ ${updateState.command}\n${result.output}\n\n$ ${[
        fallback.bin,
        ...fallback.args
      ].join(' ')}\n${fallbackResult.output}`
    }
    updateState.command = [fallback.bin, ...fallback.args].join(' ')
  }

  const after = await checkBinary(YT_DLP_BIN, ['--version'])

  updateState.versionAfter = after.version
  updateState.output = result.output
  updateState.ok = result.code === 0

  if (result.code !== 0) {
    updateState.message = 'Update failed — the output below says why.'
  } else if (after.version && after.version !== before.version) {
    updateState.message = `Updated ${before.version} → ${after.version}. Try the download again.`
  } else {
    updateState.message = `Already on the latest version (${after.version || 'unknown'}).`
  }

  updateState.running = false
  updateState.finishedAt = Date.now()

  return publicUpdateState()
}

/* ========== END YT-DLP MAINTENANCE ========== */

/* ========== TRANSCRIPTION ========== */

/**
 * Transcription runs through a Whisper command-line tool. Two are supported
 * because they take the same flags: `whisper` (openai-whisper) and
 * `whisper-ctranslate2` (faster-whisper), whichever is on PATH.
 */
const WHISPER_CANDIDATES = ['whisper', 'whisper-ctranslate2']

let whisperBinCache = ''

async function detectWhisper() {
  if (WHISPER_BIN) {
    return WHISPER_BIN
  }

  if (whisperBinCache) {
    return whisperBinCache
  }

  const locator = process.platform === 'win32' ? 'where' : 'which'

  for (const candidate of WHISPER_CANDIDATES) {
    const found = await runCommand(locator, [candidate], 10_000)

    if (found.code === 0) {
      whisperBinCache = candidate

      return candidate
    }
  }

  // Left uncached, so installing a transcriber mid-session is picked up.
  return ''
}

function buildWhisperArgs(filePath, outputDir) {
  const args = [
    filePath,
    '--model',
    WHISPER_MODEL,
    '--output_format',
    'txt',
    '--output_dir',
    outputDir
  ]

  if (WHISPER_LANGUAGE) {
    args.push('--language', WHISPER_LANGUAGE)
  }

  return args
}

/** Writes `<name>.txt` beside the job's `<name>.mp3`. */
async function transcribeFile(job) {
  const bin = await detectWhisper()

  if (!bin) {
    return {
      ok: false,
      error:
        'no transcriber found — install one with: pip install -U openai-whisper'
    }
  }

  const outputDir = path.dirname(job.filePath)
  const result = await runCommand(
    bin,
    buildWhisperArgs(job.filePath, outputDir),
    TRANSCRIBE_TIMEOUT
  )
  const expected = `${path.basename(job.filePath, path.extname(job.filePath))}.txt`
  const transcriptPath = path.join(outputDir, expected)

  if (!fs.existsSync(transcriptPath)) {
    const reason =
      result.output.trim().split('\n').pop() ||
      `${bin} exited with code ${result.code}`

    return { ok: false, error: reason }
  }

  return { ok: true, fileName: expected, filePath: transcriptPath }
}

/* ========== END TRANSCRIPTION ========== */

/* ========== HTTP HELPERS ========== */

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body)

  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''

    req.on('data', (chunk) => {
      body += chunk

      if (body.length > 10_000) {
        reject(new Error('Request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

async function serveStatic(res, urlPath) {
  const relativePath =
    urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const filePath = path.join(PUBLIC_DIR, relativePath)

  // Keep traversal (`../`) inside the public directory.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'Forbidden' })

    return
  }

  try {
    const content = await fsp.readFile(filePath)

    res.writeHead(200, {
      'content-type':
        MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache'
    })
    res.end(content)
  } catch {
    sendJson(res, 404, { error: 'Not found' })
  }
}

function isSupportedUrl(value) {
  try {
    const parsed = new URL(value)

    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/* ========== END HTTP HELPERS ========== */

/* ========== ROUTES ========== */

async function handleCreateJob(req, res) {
  const body = await readJsonBody(req)
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  const quality = ALLOWED_QUALITIES.includes(body.quality)
    ? body.quality
    : DEFAULT_QUALITY

  if (!isSupportedUrl(url)) {
    sendJson(res, 400, { error: 'Provide a valid http(s) video URL' })

    return
  }

  const job = createJob(url, quality, body.transcribe === true)

  enqueueJob(job)
  sendJson(res, 201, publicJob(job))
}

function handleJobEvents(req, res, job) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`)

  if (['done', 'error', 'cancelled'].includes(job.status)) {
    res.write('event: end\ndata: {}\n\n')
    res.end()

    return
  }

  job.listeners.add(res)
  req.on('close', () => job.listeners.delete(res))
}

function handleJobFile(req, res, job) {
  if (job.status !== 'done' || !fs.existsSync(job.filePath)) {
    sendJson(res, 404, { error: 'File is not available' })

    return
  }

  const asciiName = job.fileName
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/"/g, "'")

  res.writeHead(200, {
    'content-type': 'audio/mpeg',
    'content-length': job.fileSize,
    'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
      job.fileName
    )}`
  })
  fs.createReadStream(job.filePath).pipe(res)
}

function handleTranscriptFile(res, job) {
  if (!job.transcriptPath || !fs.existsSync(job.transcriptPath)) {
    sendJson(res, 404, { error: 'No transcript for this download' })

    return
  }

  const asciiName = job.transcriptFileName
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/"/g, "'")

  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
      job.transcriptFileName
    )}`
  })
  fs.createReadStream(job.transcriptPath).pipe(res)
}

/** Transcribes a download that finished earlier, on request from its row. */
async function handleTranscribeJob(res, job) {
  if (job.status !== 'done' || !job.filePath || !fs.existsSync(job.filePath)) {
    sendJson(res, 409, {
      error: 'That download has no audio file to transcribe'
    })

    return
  }

  if (job.transcribing) {
    sendJson(res, 409, {
      error: 'A transcription is already running for this download'
    })

    return
  }

  job.transcribing = true
  updateJob(job, { status: 'transcribing', message: 'Transcribing audio…' })

  const transcript = await transcribeFile(job)

  job.transcribing = false

  if (!transcript.ok) {
    updateJob(job, {
      status: 'done',
      message: `Transcription failed: ${transcript.error}`
    })
    sendJson(res, 500, { error: transcript.error, ...publicJob(job) })

    return
  }

  updateJob(job, {
    status: 'done',
    message: 'Audio and transcript ready',
    transcriptFileName: transcript.fileName,
    transcriptPath: transcript.filePath
  })
  sendJson(res, 200, publicJob(job))
}

function handleCancelJob(res, job) {
  if (['done', 'error', 'cancelled'].includes(job.status)) {
    sendJson(res, 409, { error: `Job is already ${job.status}` })

    return
  }

  if (job.child) {
    // The `close` handler sees the `cancelled` status and cleans up the slot.
    job.status = 'cancelled'
    job.child.kill('SIGTERM')
  } else {
    // Still queued: it never occupied a slot, so drop it without touching the
    // running count.
    const queueIndex = queue.indexOf(job)

    if (queueIndex !== -1) {
      queue.splice(queueIndex, 1)
    }

    job.settled = true

    updateJob(job, {
      status: 'cancelled',
      message: 'Cancelled',
      finishedAt: Date.now(),
      speed: '',
      eta: ''
    })
    closeJobStreams(job)
  }

  sendJson(res, 200, publicJob(job))
}

/** Re-runs a finished job's URL as a fresh job, e.g. after an update. */
function handleRetryJob(res, job) {
  const retry = createJob(job.url, job.quality, job.transcribe)

  retry.title = job.title
  enqueueJob(retry)
  sendJson(res, 201, publicJob(retry))
}

async function handleUpdateYtDlp(res) {
  if (updateState.running) {
    sendJson(res, 409, {
      error: 'An update is already running',
      ...publicUpdateState()
    })

    return
  }

  sendJson(res, 200, await runYtDlpUpdate())
}

async function router(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`)
  const jobRoute = pathname.match(
    /^\/api\/jobs\/([\w-]+)(\/events|\/file|\/transcript|\/cancel|\/retry|\/transcribe)?$/
  )

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, await readHealth())

    return
  }

  if (pathname === '/api/update-yt-dlp') {
    if (req.method === 'GET') {
      sendJson(res, 200, publicUpdateState())

      return
    }

    if (req.method === 'POST') {
      await handleUpdateYtDlp(res)

      return
    }
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    sendJson(res, 200, {
      jobs: [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(publicJob)
    })

    return
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    await handleCreateJob(req, res)

    return
  }

  if (jobRoute) {
    const job = jobs.get(jobRoute[1])

    if (!job) {
      sendJson(res, 404, { error: 'Unknown job' })

      return
    }

    if (req.method === 'GET' && jobRoute[2] === '/events') {
      handleJobEvents(req, res, job)

      return
    }

    if (req.method === 'GET' && jobRoute[2] === '/file') {
      handleJobFile(req, res, job)

      return
    }

    if (req.method === 'POST' && jobRoute[2] === '/cancel') {
      handleCancelJob(res, job)

      return
    }

    if (req.method === 'GET' && jobRoute[2] === '/transcript') {
      handleTranscriptFile(res, job)

      return
    }

    if (req.method === 'POST' && jobRoute[2] === '/retry') {
      handleRetryJob(res, job)

      return
    }

    if (req.method === 'POST' && jobRoute[2] === '/transcribe') {
      await handleTranscribeJob(res, job)

      return
    }

    if (req.method === 'GET' && !jobRoute[2]) {
      sendJson(res, 200, publicJob(job))

      return
    }
  }

  if (req.method === 'GET') {
    await serveStatic(res, pathname)

    return
  }

  sendJson(res, 405, { error: 'Method not allowed' })
}

/* ========== END ROUTES ========== */

/* ========== BROWSER LAUNCH ========== */

/** Opens the UI in the default browser; a failure here is never fatal. */
function openInBrowser(url) {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open'

  try {
    const child = spawn(opener, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32'
    })

    child.on('error', () => {})
    child.unref()
  } catch {
    // The user can always open the printed URL themselves.
  }
}

/* ========== END BROWSER LAUNCH ========== */

/* ========== BOOTSTRAP ========== */

const server = http.createServer((req, res) => {
  router(req, res).catch((error) => {
    sendJson(res, 500, { error: error.message })
  })
})

async function start() {
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true })

  const health = await readHealth()

  server.listen(PORT, HOST, () => {
    console.log(`\n  MP3 Downloader running at http://${HOST}:${PORT}`)
    console.log(`  Saving files to ${DOWNLOAD_DIR}\n`)

    if (!health.ytDlp.available) {
      console.log(
        '  ⚠ yt-dlp was not found — install it with: pip install -U yt-dlp'
      )
    }

    if (!health.ffmpeg.available) {
      console.log(
        '  ⚠ ffmpeg was not found — MP3 conversion needs it (brew/apt install ffmpeg)'
      )
    }

    if (OPEN_BROWSER) {
      openInBrowser(`http://${HOST}:${PORT}`)
    }
  })
}

function shutdown() {
  for (const job of jobs.values()) {
    if (job.child) {
      job.child.kill('SIGTERM')
    }
  }

  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

if (require.main === module) {
  start().catch((error) => {
    console.error(`Failed to start: ${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  server,
  start,
  isSupportedUrl,
  parseProgressLine,
  ALLOWED_QUALITIES
}

/* ========== END BOOTSTRAP ========== */
