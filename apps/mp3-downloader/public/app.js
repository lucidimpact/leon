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
  row.querySelector('[data-message]').textContent = job.message

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
loadHealth().catch(() => {})
loadExistingJobs().catch(() => {})

/* ========== END BOOTSTRAP ========== */
