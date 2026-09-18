/* ========== ELEMENTS ========== */

const form = document.getElementById('download-form')
const urlInput = document.getElementById('url')
const qualitySelect = document.getElementById('quality')
const submitButton = document.getElementById('submit-button')
const formError = document.getElementById('form-error')
const jobList = document.getElementById('job-list')
const jobTemplate = document.getElementById('job-template')
const emptyState = document.getElementById('empty-state')
const statusCard = document.getElementById('status-card')
const statusList = document.getElementById('status-list')
const outputDir = document.getElementById('output-dir')
const fixButton = document.getElementById('fix-button')
const fixVersion = document.getElementById('fix-version')
const fixMessage = document.getElementById('fix-message')
const fixOutput = document.getElementById('fix-output')

/** jobId -> rendered <li> */
const rows = new Map()

/* ========== END ELEMENTS ========== */

/* ========== HELPERS ========== */

function formatBytes(bytes) {
  if (!bytes) {
    return ''
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function showError(message) {
  formError.textContent = message
  formError.hidden = !message
}

/* ========== END HELPERS ========== */

/* ========== RENDERING ========== */

function renderJob(job) {
  let row = rows.get(job.id)

  if (!row) {
    row = jobTemplate.content.firstElementChild.cloneNode(true)
    rows.set(job.id, row)
    jobList.prepend(row)

    row
      .querySelector('[data-cancel]')
      .addEventListener('click', () => cancelJob(job.id))
    row
      .querySelector('[data-retry]')
      .addEventListener('click', () => retryJob(job.id))
    row.querySelector('[data-fix]').addEventListener('click', () => {
      document
        .getElementById('maintenance-card')
        .scrollIntoView({ behavior: 'smooth' })
      runFix()
    })
  }

  emptyState.hidden = rows.size > 0

  const isFinished = ['done', 'error', 'cancelled'].includes(job.status)

  row.querySelector('[data-title]').textContent = job.title || job.url
  row.querySelector('[data-title]').title = job.url

  const badge = row.querySelector('[data-status]')

  badge.textContent = job.status
  badge.dataset.state = job.status

  row.querySelector('[data-bar]').style.width =
    `${job.status === 'done' ? 100 : job.percent}%`
  const messageCell = row.querySelector('[data-message]')

  messageCell.textContent = job.message
  messageCell.title = job.message

  const stats = [
    job.speed,
    job.eta && `ETA ${job.eta}`,
    formatBytes(job.fileSize)
  ].filter(Boolean)

  row.querySelector('[data-stats]').textContent = stats.join(' · ')

  const downloadLink = row.querySelector('[data-download]')

  downloadLink.hidden = job.status !== 'done'
  downloadLink.href = `/api/jobs/${job.id}/file`
  downloadLink.setAttribute('download', job.fileName || 'audio.mp3')

  row.querySelector('[data-cancel]').hidden = isFinished
  row.querySelector('[data-retry]').hidden = job.status !== 'error'
  row.querySelector('[data-fix]').hidden = job.status !== 'error'
}

/* ========== END RENDERING ========== */

/* ========== JOB LIFECYCLE ========== */

function followJob(jobId) {
  const source = new EventSource(`/api/jobs/${jobId}/events`)

  source.onmessage = (event) => renderJob(JSON.parse(event.data))
  source.addEventListener('end', () => source.close())
  source.onerror = () => source.close()
}

async function cancelJob(jobId) {
  await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {})
}

async function retryJob(jobId) {
  const response = await fetch(`/api/jobs/${jobId}/retry`, { method: 'POST' })

  if (!response.ok) {
    return
  }

  const job = await response.json()

  renderJob(job)
  followJob(job.id)
}

async function submitForm(event) {
  event.preventDefault()
  showError('')
  submitButton.disabled = true

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: urlInput.value.trim(),
        quality: qualitySelect.value
      })
    })
    const body = await response.json()

    if (!response.ok) {
      showError(body.error || 'Could not start the download')

      return
    }

    renderJob(body)
    followJob(body.id)
    urlInput.value = ''
  } catch (error) {
    showError(error.message)
  } finally {
    submitButton.disabled = false
  }
}

/* ========== END JOB LIFECYCLE ========== */

/* ========== MAINTENANCE ========== */

function renderUpdateState(state) {
  fixButton.disabled = state.running
  fixButton.textContent = state.running ? 'Updating…' : 'Fix download process'

  if (state.versionAfter || state.versionBefore) {
    fixVersion.textContent = `yt-dlp ${state.versionAfter || state.versionBefore}`
  }

  fixMessage.hidden = !state.message
  fixMessage.textContent = state.message || ''

  if (state.ok !== null) {
    fixMessage.dataset.state = state.ok ? 'ok' : 'failed'
  }

  fixOutput.hidden = !state.output
  fixOutput.textContent = state.output || ''
}

/** A second tab can be watching the same update, so poll until it settles. */
async function pollUpdateState() {
  const state = await fetch('/api/update-yt-dlp').then((response) =>
    response.json()
  )

  renderUpdateState(state)

  if (state.running) {
    setTimeout(pollUpdateState, 2000)
  }
}

async function runFix() {
  if (fixButton.disabled) {
    return
  }

  renderUpdateState({
    running: true,
    message: 'Updating yt-dlp…',
    ok: null,
    output: ''
  })

  try {
    const response = await fetch('/api/update-yt-dlp', { method: 'POST' })
    const state = await response.json()

    if (response.status === 409) {
      await pollUpdateState()

      return
    }

    renderUpdateState(state)
  } catch (error) {
    renderUpdateState({
      running: false,
      ok: false,
      message: `Could not run the update: ${error.message}`,
      output: ''
    })
  }
}

/* ========== END MAINTENANCE ========== */

/* ========== BOOTSTRAP ========== */

async function loadHealth() {
  const health = await fetch('/api/health').then((response) => response.json())
  const missing = []

  if (!health.ytDlp.available) {
    missing.push(
      '<strong>yt-dlp</strong> is missing — install it with <code>pip install -U yt-dlp</code>'
    )
  }

  if (!health.ffmpeg.available) {
    missing.push(
      '<strong>ffmpeg</strong> is missing — install it with <code>brew install ffmpeg</code> or <code>apt install ffmpeg</code>'
    )
  }

  statusList.innerHTML = missing.map((item) => `<li>${item}</li>`).join('')
  statusCard.hidden = missing.length === 0
  outputDir.textContent = `Saving to ${health.outputDir}`

  if (health.ytDlp.available) {
    fixVersion.textContent = `yt-dlp ${health.ytDlp.version}`
  }
}

async function loadExistingJobs() {
  const { jobs } = await fetch('/api/jobs').then((response) => response.json())

  for (const job of [...jobs].reverse()) {
    renderJob(job)

    if (!['done', 'error', 'cancelled'].includes(job.status)) {
      followJob(job.id)
    }
  }
}

form.addEventListener('submit', submitForm)
fixButton.addEventListener('click', runFix)
loadHealth().catch(() => {})
loadExistingJobs().catch(() => {})
pollUpdateState().catch(() => {})

/* ========== END BOOTSTRAP ========== */
