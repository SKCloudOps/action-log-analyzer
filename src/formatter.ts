import { FailureAnalysis, BuildParam, GitRef, ClonedRepo, JobTiming, TestSummary, Annotation } from './analyzer'

const MAX_ERROR_LINES = 10

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function buildGroupedErrorBlock(
  errorLinesByCategory: Record<string, string[]>,
  exactMatchLine: string,
  maxLines: number,
  runUrl: string,
  totalCount: number
): string {
  const categories = Object.keys(errorLinesByCategory).sort()
  if (categories.length === 0) return ''

  const parts: string[] = []
  let linesShown = 0
  const truncated = totalCount > maxLines

  for (const cat of categories) {
    const lines = errorLinesByCategory[cat]
    const remaining = maxLines - linesShown
    const showLines = truncated ? lines.slice(0, Math.min(lines.length, Math.max(0, remaining))) : lines
    const hidden = lines.length - showLines.length

    const content = showLines
      .map(line => (line === exactMatchLine ? `>>> ${line}` : `   ${line}`))
      .join('\n')
    const suffix = hidden > 0 ? `\n   ... ${hidden} more (see full log)` : ''
    const header = hidden > 0 ? `${cat} (${showLines.length} of ${lines.length})` : `${cat} (${lines.length})`

    parts.push(`<details>
<summary>${header}</summary>

\`\`\`text
${content}${suffix}
\`\`\`
</details>`)
    linesShown += showLines.length
    if (linesShown >= maxLines && truncated) break
  }

  const viewFull = truncated ? `\n\n> **[View full log](${runUrl})** — ${totalCount - maxLines} more line${totalCount - maxLines === 1 ? '' : 's'} not shown` : ''
  return `\n${parts.join('\n\n')}${viewFull}`
}

function buildGroupedErrorBlockSummary(
  errorLinesByCategory: Record<string, string[]>,
  exactMatchLine: string,
  maxLines: number,
  runUrl: string,
  totalCount: number
): string {
  const categories = Object.keys(errorLinesByCategory).sort()
  if (categories.length === 0) return '\n*No error lines captured*'

  const parts: string[] = []
  let linesShown = 0
  const truncated = totalCount > maxLines

  for (const cat of categories) {
    const lines = errorLinesByCategory[cat]
    const remaining = maxLines - linesShown
    const showLines = truncated ? lines.slice(0, Math.min(lines.length, Math.max(0, remaining))) : lines
    const hidden = lines.length - showLines.length

    const content = showLines
      .map(line => (line === exactMatchLine ? `>>> ${line}` : `   ${line}`))
      .join('\n')
    const suffix = hidden > 0 ? `\n   ... ${hidden} more` : ''
    const header = hidden > 0 ? `${cat} (${showLines.length}/${lines.length})` : `${cat} (${lines.length})`

    parts.push(`<details>
<summary>${header}</summary>

\`\`\`text
${content}${suffix}
\`\`\`
</details>`)
    linesShown += showLines.length
    if (linesShown >= maxLines && truncated) break
  }

  const viewFull = truncated ? `\n\n> **[View full log](${runUrl})** — ${totalCount.toLocaleString()} lines total` : ''
  return parts.join('\n\n') + viewFull
}

function buildErrorContextBlock(analysis: FailureAnalysis): string {
  const before = analysis.contextBefore || []
  const after = analysis.contextAfter || []
  const exact = analysis.exactMatchLine
  if (!exact && before.length === 0 && after.length === 0) return ''

  const lineRef = analysis.exactMatchLineNumber > 0 ? `*Line ${analysis.exactMatchLineNumber} of ${analysis.totalLines}*` : ''
  const contextLines: string[] = []
  before.forEach(line => contextLines.push(`   ${line}`))
  if (exact) contextLines.push(`>>> ${exact}`)
  after.forEach(line => contextLines.push(`   ${line}`))

  return `\n#### Error Output
${lineRef ? `${lineRef}  \n` : ''}\`\`\`text
${contextLines.join('\n')}
\`\`\`

> [!DANGER]
> **Error:** \`${(exact || 'No exact match').replace(/`/g, '\\`').replace(/\n/g, ' ')}\`
`
}

const SEVERITY_LABEL = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info'
}

const SEVERITY_EMOJI = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵'
}

function buildWarningsSection(
  warningLines: string[],
  warningLinesByCategory: Record<string, string[]>,
  maxLines: number
): string {
  if (warningLines.length === 0) return ''

  const categories = Object.keys(warningLinesByCategory).sort()
  const parts: string[] = []
  let linesShown = 0
  const truncated = warningLines.length > maxLines

  for (const cat of categories) {
    const lines = warningLinesByCategory[cat]
    const remaining = maxLines - linesShown
    const showLines = truncated ? lines.slice(0, Math.min(lines.length, Math.max(0, remaining))) : lines
    const hidden = lines.length - showLines.length

    const content = showLines.map(line => `   ${line}`).join('\n')
    const suffix = hidden > 0 ? `\n   ... ${hidden} more` : ''
    const header = hidden > 0 ? `${cat} (${showLines.length}/${lines.length})` : `${cat} (${lines.length})`

    parts.push(`<details>
<summary>${header}</summary>

\`\`\`text
${content}${suffix}
\`\`\`
</details>`)
    linesShown += showLines.length
    if (linesShown >= maxLines && truncated) break
  }

  return parts.join('\n\n')
}

function buildBuildParamsSection(params: BuildParam[]): string {
  if (params.length === 0) return ''

  const rows = params.map(p => {
    const displayValue = p.value.length > 60 ? p.value.slice(0, 57) + '...' : p.value
    return `| \`${p.key}\` | \`${displayValue}\` | ${p.source} |`
  })

  return `| Parameter | Value | Source |
|:----------|:------|:-------|
${rows.join('\n')}`
}

function buildClonedReposTable(repos: ClonedRepo[]): string {
  if (repos.length === 0) return ''

  const rows = repos.map(r => {
    const repoLink = r.repository.includes('/')
      ? `[${r.repository}](https://github.com/${r.repository})`
      : `\`${r.repository}\``
    const commitDisplay = r.commit !== '—' ? `\`${r.commit.substring(0, 7)}\`` : '—'
    return `| ${repoLink} | \`${r.branch}\` | ${commitDisplay} | ${r.depth} |`
  })

  return `| Repository | Branch / Tag | Commit | Depth |
|:-----------|:-------------|:-------|:------|
${rows.join('\n')}`
}

function buildActionsAndImagesTable(refs: GitRef[]): string {
  const filtered = refs.filter(r => r.type === 'action' || r.type === 'docker')
  if (filtered.length === 0) return ''

  const typeEmojis: Record<string, string> = { action: '🔧', docker: '🐳' }
  const typeLabels: Record<string, string> = { action: 'Action', docker: 'Docker' }

  const rows = filtered.map(r => {
    const emoji = typeEmojis[r.type] || '📌'
    const label = typeLabels[r.type] || r.type
    const repoDisplay = r.type === 'action'
      ? `[${r.repo}](https://github.com/${r.repo})`
      : `\`${r.repo}\``
    return `| ${emoji} ${label} | ${repoDisplay} | \`${r.ref}\` |`
  })

  return `| Type | Repository / Image | Ref / Tag |
|:-----|:-------------------|:----------|
${rows.join('\n')}`
}

function buildTimingSection(timing: JobTiming): string {
  if (timing.jobDurationMs === 0) return ''

  const parts: string[] = []
  parts.push(`| Metric | Value |`)
  parts.push(`|:-------|:------|`)
  parts.push(`| Total duration | **${formatDuration(timing.jobDurationMs)}** |`)

  if (timing.queueTimeMs > 30_000) {
    parts.push(`| Queue wait | ${formatDuration(timing.queueTimeMs)} |`)
  }

  if (timing.slowestStep) {
    const pct = timing.jobDurationMs > 0
      ? ` (${Math.round(timing.slowestStep.durationMs / timing.jobDurationMs * 100)}%)`
      : ''
    parts.push(`| Slowest step | \`${timing.slowestStep.name}\` — ${formatDuration(timing.slowestStep.durationMs)}${pct} |`)
  }

  const slowSteps = timing.steps.filter(s => s.isSlow && s.name !== timing.slowestStep?.name)
  if (slowSteps.length > 0) {
    const names = slowSteps.map(s => `\`${s.name}\` (${formatDuration(s.durationMs)})`).join(', ')
    parts.push(`| Other slow steps | ${names} |`)
  }

  return parts.join('\n')
}

function buildTestResultsSection(testSummary: TestSummary): string {
  const parts: string[] = []
  const statusIcon = testSummary.failed > 0 ? '❌' : '✅'

  parts.push(`| Framework | Passed | Failed | Skipped | Total | Status |`)
  parts.push(`|:----------|-------:|-------:|--------:|------:|:------:|`)
  parts.push(`| ${testSummary.framework || 'Unknown'} | ${testSummary.passed} | ${testSummary.failed} | ${testSummary.skipped} | ${testSummary.total} | ${statusIcon} |`)

  if (testSummary.failedTests.length > 0) {
    parts.push('')
    parts.push('<details>')
    parts.push(`<summary>Failed tests (${testSummary.failedTests.length})</summary>`)
    parts.push('')
    parts.push('```text')
    parts.push(testSummary.failedTests.join('\n'))
    parts.push('```')
    parts.push('</details>')
  }

  return parts.join('\n')
}

function buildAnnotationsSection(annotations: Annotation[]): string {
  if (annotations.length === 0) return ''

  const grouped: Record<string, Annotation[]> = {}
  for (const a of annotations) {
    const key = a.level
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(a)
  }

  const levelOrder = ['error', 'warning', 'notice'] as const
  const levelIcons = { error: '🔴', warning: '🟡', notice: '🔵' }
  const parts: string[] = []

  for (const level of levelOrder) {
    const items = grouped[level]
    if (!items || items.length === 0) continue
    parts.push(`<details>`)
    parts.push(`<summary>${levelIcons[level]} ${level.charAt(0).toUpperCase() + level.slice(1)} (${items.length})</summary>`)
    parts.push('')
    parts.push('```text')
    for (const a of items.slice(0, 10)) {
      const loc = a.file ? ` [${a.file}${a.line ? `:${a.line}` : ''}]` : ''
      parts.push(`${a.message}${loc}`)
    }
    if (items.length > 10) parts.push(`... ${items.length - 10} more`)
    parts.push('```')
    parts.push('</details>')
  }

  return parts.join('\n')
}

function buildRunMeta(
  runAttempt: number,
  runNumber: number,
  triggerEvent: string,
  workflowName: string
): string {
  const parts: string[] = []
  if (workflowName) parts.push(`**${workflowName}**`)
  if (triggerEvent) parts.push(`\`${triggerEvent}\``)
  if (runNumber > 0) {
    let runLabel = `Run #${runNumber}`
    if (runAttempt > 1) runLabel += ` · Attempt #${runAttempt} 🔄`
    parts.push(runLabel)
  }
  return parts.length > 0 ? parts.join(' · ') : ''
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function buildArtifactsAndLinksSection(
  runUrl: string,
  artifacts: { name: string; size_in_bytes: number }[],
  extractedLinks: { url: string; label?: string }[],
  repo: string
): string {
  const parts: string[] = []

  parts.push(`| Link | Description |
|:-----|:------------|
| [View workflow run](${runUrl}) | Full logs & artifact downloads |`)

  if (artifacts.length > 0) {
    for (const a of artifacts) {
      parts.push(`| [\`${a.name}\`](${runUrl}) | Artifact · ${formatBytes(a.size_in_bytes)} |`)
    }
  }

  if (extractedLinks.length > 0) {
    for (const { url, label } of extractedLinks) {
      let display = label || ''
      if (!display) {
        try { display = new URL(url).hostname.replace(/^www\./, '') } catch { display = 'Link' }
      }
      const shortUrl = url.length > 55 ? url.slice(0, 52) + '…' : url
      parts.push(`| [${display}](${url}) | ${shortUrl} |`)
    }
  }

  return parts.join('\n')
}

export function formatPRComment(
  analysis: FailureAnalysis,
  jobName: string,
  runUrl: string,
  steps: { name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }[],
  repo: string,
  branch: string,
  commit: string,
  artifacts: { name: string; size_in_bytes: number }[] = [],
  extractedLinks: { url: string; label?: string }[] = [],
  gitRefs: GitRef[] = [],
  clonedRepos: ClonedRepo[] = [],
  timing: JobTiming | null = null,
  testSummary: TestSummary | null = null,
  annotations: Annotation[] = [],
  runAttempt: number = 1,
  runNumber: number = 0,
  triggerEvent: string = '',
  workflowName: string = ''
): string {
  const passedCount = steps.filter(s => s.conclusion === 'success').length
  const totalCount = steps.length
  const stepBar = steps.map(s =>
    s.conclusion === 'success' ? '🟢' :
    s.conclusion === 'failure' ? '🔴' :
    s.conclusion === 'skipped' ? '⏭️' : '🟡'
  ).join('')

  const failedIdx = steps.findIndex(s => s.conclusion === 'failure')
  const slowStepNames = new Set(timing?.steps.filter(s => s.isSlow).map(s => s.name) ?? [])
  const commandRows = steps.map((step, i) => {
    const icon = step.conclusion === 'success' ? '✅' : step.conclusion === 'failure' ? '❌' : '⏳'
    const duration = step.started_at && step.completed_at
      ? formatDuration(new Date(step.completed_at).getTime() - new Date(step.started_at).getTime())
      : '—'
    const slowFlag = slowStepNames.has(step.name) ? ' 🐢' : ''
    const failedMarker = i === failedIdx ? '\n                                             ↑ FAILED HERE' : ''
    return `| ${i + 1} | ${step.name} | ${icon} | ${duration}${slowFlag} |${failedMarker}`
  }).join('\n')

  const exactMatchLine = (analysis.exactMatchLine || 'No exact match').replace(/`/g, '\\`').replace(/\n/g, ' ')
  const docsLink = analysis.docsUrl ? `\n\n[Related documentation](${analysis.docsUrl})` : ''

  const MAX_LINES = 10
  const errorBlock = buildGroupedErrorBlock(analysis.errorLinesByCategory || {}, analysis.exactMatchLine, MAX_LINES, runUrl, analysis.errorLines.length)

  const meta = buildRunMeta(runAttempt, runNumber, triggerEvent, workflowName)
  const metaLine = meta ? `\n${meta}\n` : ''

  return `## Action Log Analyzer — ${jobName} Build Report

\`${repo}\` · \`${branch}\` · \`${commit.substring(0, 7)}\`${metaLine}

${stepBar}  **${passedCount}/${totalCount} steps passed**

### Health Scorecard
| Category | Score | Value | Status |
|:---------|:------|:------|:-------|
| Build | ${analysis.category} | ${analysis.totalLines.toLocaleString()} lines | ${SEVERITY_EMOJI[analysis.severity]} ${SEVERITY_LABEL[analysis.severity]} |
| Pattern | \`${analysis.matchedPattern}\` | ${analysis.errorLines.length} error lines | matched |
${timing && timing.jobDurationMs > 0 ? `| Duration | ${formatDuration(timing.jobDurationMs)} | ${timing.slowestStep ? `Slowest: \`${timing.slowestStep.name}\`` : '—'} | ${timing.queueTimeMs > 30000 ? `⏳ ${formatDuration(timing.queueTimeMs)} queued` : '✅'} |
` : ''}
### Command Timeline
| # | Command | Status | Duration |
|:--|:--------|:------:|:---------|
${commandRows}

### Root Cause
${analysis.rootCause}

### Exact Error (line ${analysis.exactMatchLineNumber} of ${analysis.totalLines.toLocaleString()})
\`\`\`text
${exactMatchLine}
\`\`\`

### Suggested Fix
${analysis.suggestion}${docsLink}
${errorBlock}
${testSummary ? `
### Test Results
${buildTestResultsSection(testSummary)}
` : ''}${annotations.length > 0 ? `
### Annotations (${annotations.length})
${buildAnnotationsSection(annotations)}
` : ''}${analysis.warningLines.length > 0 ? `
### Warnings (${analysis.warningLines.length})
${buildWarningsSection(analysis.warningLines, analysis.warningLinesByCategory, 10)}
` : ''}${analysis.buildParams.length > 0 ? `
### Build Parameters
${buildBuildParamsSection(analysis.buildParams)}
` : ''}${clonedRepos.length > 0 ? `
### Cloned Repositories
${buildClonedReposTable(clonedRepos)}
` : ''}${gitRefs.filter(r => r.type === 'action' || r.type === 'docker').length > 0 ? `
### Actions & Docker Images
${buildActionsAndImagesTable(gitRefs)}
` : ''}
### Artifacts & Links
${buildArtifactsAndLinksSection(runUrl, artifacts, extractedLinks, repo)}

---
*[Action Log Analyzer](https://github.com/SKCloudOps/action-log-analyzer)*`
}

export function formatJobSummary(
  analysis: FailureAnalysis,
  jobName: string,
  runUrl: string,
  steps: { name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }[],
  triggeredBy: string,
  branch: string,
  commit: string,
  repo: string,
  artifacts: { name: string; size_in_bytes: number }[] = [],
  extractedLinks: { url: string; label?: string }[] = [],
  gitRefs: GitRef[] = [],
  clonedRepos: ClonedRepo[] = [],
  timing: JobTiming | null = null,
  testSummary: TestSummary | null = null,
  annotations: Annotation[] = [],
  runAttempt: number = 1,
  runNumber: number = 0,
  triggerEvent: string = '',
  workflowName: string = ''
): string {
  const label = SEVERITY_LABEL[analysis.severity]
  const emoji = SEVERITY_EMOJI[analysis.severity]
  const now = new Date().toUTCString()

  const docsLink = analysis.docsUrl ? `\n\n[Documentation](${analysis.docsUrl})` : ''

  const passedCount = steps.filter(s => s.conclusion === 'success').length
  const totalCount = steps.length
  const stepBar = steps.map(s =>
    s.conclusion === 'success' ? '🟢' :
    s.conclusion === 'failure' ? '🔴' :
    s.conclusion === 'skipped' ? '⏭️' : '🟡'
  ).join('')

  const failedIdx = steps.findIndex(s => s.conclusion === 'failure')
  const slowStepNames = new Set(timing?.steps.filter(s => s.isSlow).map(s => s.name) ?? [])
  const commandRows = steps.map((step, i) => {
    const icon = step.conclusion === 'success' ? '✅' : step.conclusion === 'failure' ? '❌' : '⏳'
    const duration = step.started_at && step.completed_at
      ? formatDuration(new Date(step.completed_at).getTime() - new Date(step.started_at).getTime())
      : '—'
    const slowFlag = slowStepNames.has(step.name) ? ' 🐢' : ''
    const failedMarker = i === failedIdx ? '\n                                             ↑ FAILED HERE' : ''
    return `| ${i + 1} | ${step.name} | ${icon} | ${duration}${slowFlag} |${failedMarker}`
  }).join('\n')

  const exactMatchLine = (analysis.exactMatchLine || 'No exact match').replace(/`/g, '\\`').replace(/\n/g, ' ')
  const meta = buildRunMeta(runAttempt, runNumber, triggerEvent, workflowName)
  const metaLine = meta ? `\n${meta}\n` : ''

  return `# Action Log Analyzer — ${jobName} Build Report

\`${repo}\` · \`${branch}\` · [\`${commit.substring(0, 7)}\`](https://github.com/${repo}/commit/${commit})${metaLine}

${stepBar}  **${passedCount}/${totalCount} steps passed**

## Health Scorecard
| Category | Score | Value | Status |
|:---------|:------|:------|:-------|
| Build | ${analysis.category} | ${analysis.totalLines.toLocaleString()} lines | ${emoji} ${label} |
| Pattern | \`${analysis.matchedPattern}\` | ${analysis.errorLines.length} error lines | matched |
${timing && timing.jobDurationMs > 0 ? `| Duration | ${formatDuration(timing.jobDurationMs)} | ${timing.slowestStep ? `Slowest: \`${timing.slowestStep.name}\`` : '—'} | ${timing.queueTimeMs > 30000 ? `⏳ ${formatDuration(timing.queueTimeMs)} queued` : '✅'} |
` : ''}
## Command Timeline
| # | Command | Status | Duration |
|:--|:--------|:------:|:---------|
${commandRows}

## Root Cause
${analysis.rootCause}

## Exact Error (line ${analysis.exactMatchLineNumber} of ${analysis.totalLines.toLocaleString()})
\`\`\`text
${exactMatchLine}
\`\`\`

## Suggested Fix
${analysis.suggestion}${docsLink}

---

## Error Lines by Category
${buildGroupedErrorBlockSummary(analysis.errorLinesByCategory || {}, analysis.exactMatchLine, MAX_ERROR_LINES, runUrl, analysis.errorLines.length)}

---
${testSummary ? `
## Test Results
${buildTestResultsSection(testSummary)}

---
` : ''}${annotations.length > 0 ? `
## Annotations (${annotations.length})
${buildAnnotationsSection(annotations)}

---
` : ''}${timing && timing.jobDurationMs > 0 ? `
## Performance
${buildTimingSection(timing)}

---
` : ''}${analysis.warningLines.length > 0 ? `
## Warnings (${analysis.warningLines.length})
${buildWarningsSection(analysis.warningLines, analysis.warningLinesByCategory, MAX_ERROR_LINES)}

---
` : ''}${analysis.buildParams.length > 0 ? `
## Build Parameters
${buildBuildParamsSection(analysis.buildParams)}

---
` : ''}${clonedRepos.length > 0 ? `
## Cloned Repositories
${buildClonedReposTable(clonedRepos)}

---
` : ''}${gitRefs.filter(r => r.type === 'action' || r.type === 'docker').length > 0 ? `
## Actions & Docker Images
${buildActionsAndImagesTable(gitRefs)}

---
` : ''}
## Artifacts & Links
${buildArtifactsAndLinksSection(runUrl, artifacts, extractedLinks, repo)}

---
*Action Log Analyzer · ${now}*`
}

export function formatSuccessSummary(
  runUrl: string,
  jobs: { name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null; steps?: { name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }[] }[],
  triggeredBy: string,
  branch: string,
  commit: string,
  repo: string,
  artifacts: { name: string; size_in_bytes: number }[] = [],
  extractedLinks: { url: string; label?: string }[] = [],
  warningLines: string[] = [],
  warningLinesByCategory: Record<string, string[]> = {},
  buildParams: BuildParam[] = [],
  gitRefs: GitRef[] = [],
  clonedRepos: ClonedRepo[] = [],
  timings: JobTiming[] = [],
  testSummary: TestSummary | null = null,
  annotations: Annotation[] = [],
  runAttempt: number = 1,
  runNumber: number = 0,
  triggerEvent: string = '',
  workflowName: string = ''
): string {
  const now = new Date().toUTCString()

  const jobRows = jobs.map(job => {
    const icon = job.conclusion === 'success' ? '✅' : job.conclusion === 'failure' ? '❌' : '⏳'
    const jobTiming = timings.find(t => t.jobName === job.name)
    const dur = jobTiming && jobTiming.jobDurationMs > 0 ? formatDuration(jobTiming.jobDurationMs) : '—'
    return `| ${icon} | \`${job.name}\` | ${job.conclusion ?? 'in progress'} | ${dur} |`
  }).join('\n')

  const totalSteps = jobs.reduce((sum, j) => sum + (j.steps?.length ?? 0), 0)
  const passedSteps = jobs.reduce((sum, j) => sum + (j.steps?.filter(s => s.conclusion === 'success').length ?? 0), 0)
  const stepBar = jobs.flatMap(j => j.steps ?? []).map(s =>
    s.conclusion === 'success' ? '🟢' : s.conclusion === 'failure' ? '🔴' : '🟡'
  ).join('')
  const stepBarDisplay = stepBar ? `\n\n${stepBar}  **${passedSteps}/${totalSteps} steps passed**` : ''

  const totalDurationMs = timings.reduce((sum, t) => sum + t.jobDurationMs, 0)
  const allSlowSteps = timings.flatMap(t => t.steps.filter(s => s.isSlow))
  const maxQueueMs = Math.max(0, ...timings.map(t => t.queueTimeMs))

  let timelineSection = ''
  const allSteps: { jobName: string; step: { name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null } }[] = []
  for (const job of jobs) {
    for (const step of job.steps ?? []) {
      allSteps.push({ jobName: job.name, step })
    }
  }
  const slowStepNames = new Set(allSlowSteps.map(s => s.name))
  if (allSteps.length > 0) {
    const stepRows = allSteps.map(({ jobName, step }, i) => {
      const icon = step.conclusion === 'success' ? '✅' : step.conclusion === 'failure' ? '❌' : '⏳'
      const duration = step.started_at && step.completed_at
        ? formatDuration(new Date(step.completed_at).getTime() - new Date(step.started_at).getTime())
        : '—'
      const slowFlag = slowStepNames.has(step.name) ? ' 🐢' : ''
      return `| ${i + 1} | \`${step.name}\` | ${jobName} | ${icon} | ${duration}${slowFlag} |`
    }).join('\n')
    timelineSection = `

### Command Timeline
| # | Step | Job | Status | Duration |
|:--|:-----|:----|:------:|:---------|
${stepRows}`
  }

  const meta = buildRunMeta(runAttempt, runNumber, triggerEvent, workflowName)
  const metaLine = meta ? `\n${meta}\n` : ''

  return `# Log Analyzer Report

## All Jobs Passed

\`${repo}\` · \`${branch}\` · [\`${commit.substring(0, 7)}\`](https://github.com/${repo}/commit/${commit})${metaLine}${stepBarDisplay}

### Job Summary
| Status | Job | Result | Duration |
|:------:|:----|:-------|:---------|
${jobRows}

### Run Overview
| Property | Value |
|:---------|:------|
| Repository | \`${repo}\` |
| Branch | \`${branch}\` |
| Commit | [\`${commit.substring(0, 7)}\`](https://github.com/${repo}/commit/${commit}) |
| Triggered by | \`${triggeredBy}\` |
${triggerEvent ? `| Event | \`${triggerEvent}\` |\n` : ''}${workflowName ? `| Workflow | \`${workflowName}\` |\n` : ''}| Jobs passed | ${jobs.length} |
| Steps completed | ${passedSteps}/${totalSteps} |
${totalDurationMs > 0 ? `| Total duration | **${formatDuration(totalDurationMs)}** |\n` : ''}${maxQueueMs > 30000 ? `| Max queue wait | ⏳ ${formatDuration(maxQueueMs)} |\n` : ''}${timelineSection}

${testSummary ? `### Test Results
${buildTestResultsSection(testSummary)}

` : ''}${annotations.length > 0 ? `### Annotations (${annotations.length})
${buildAnnotationsSection(annotations)}

` : ''}${warningLines.length > 0 ? `### Warnings (${warningLines.length})
${buildWarningsSection(warningLines, warningLinesByCategory, 10)}

` : ''}${buildParams.length > 0 ? `### Build Parameters
${buildBuildParamsSection(buildParams)}

` : ''}${clonedRepos.length > 0 ? `### Cloned Repositories
${buildClonedReposTable(clonedRepos)}

` : ''}${gitRefs.filter(r => r.type === 'action' || r.type === 'docker').length > 0 ? `### Actions & Docker Images
${buildActionsAndImagesTable(gitRefs)}

` : ''}### Artifacts & Links
${buildArtifactsAndLinksSection(runUrl, artifacts, extractedLinks, repo)}

---
*Action Log Analyzer · ${now}*`
}

export function formatSuccessPRComment(
  jobNames: string[],
  runUrl: string,
  artifacts: { name: string; size_in_bytes: number }[] = [],
  extractedLinks: { url: string; label?: string }[] = [],
  warningLines: string[] = [],
  warningLinesByCategory: Record<string, string[]> = {},
  buildParams: BuildParam[] = [],
  gitRefs: GitRef[] = [],
  clonedRepos: ClonedRepo[] = [],
  timings: JobTiming[] = [],
  testSummary: TestSummary | null = null,
  annotations: Annotation[] = [],
  runAttempt: number = 1,
  runNumber: number = 0,
  triggerEvent: string = '',
  workflowName: string = ''
): string {
  const jobsList = jobNames.map(n => `\`${n}\``).join(', ')

  const totalDurationMs = timings.reduce((sum, t) => sum + t.jobDurationMs, 0)
  const durationNote = totalDurationMs > 0 ? ` in **${formatDuration(totalDurationMs)}**` : ''
  const meta = buildRunMeta(runAttempt, runNumber, triggerEvent, workflowName)
  const metaLine = meta ? `\n${meta}\n` : ''

  let extra = `\n\n[View workflow run](${runUrl})`
  if (artifacts.length > 0 || extractedLinks.length > 0) {
    const parts: string[] = []
    if (artifacts.length > 0) {
      parts.push(`**Artifacts:** ${artifacts.map(a => `\`${a.name}\` (${Math.round(a.size_in_bytes / 1024)} KB)`).join(', ')}`)
    }
    if (extractedLinks.length > 0) {
      parts.push(`**Links:** ${extractedLinks.slice(0, 5).map(l => {
        let display = l.label || ''
        if (!display) { try { display = new URL(l.url).hostname.replace(/^www\./, '') } catch { display = 'Link' } }
        return `[${display}](${l.url})`
      }).join(', ')}`)
    }
    extra = `\n\n${parts.join('\n\n')}\n\n[View workflow run & download](${runUrl})`
  }

  const testSection = testSummary
    ? `\n\n### Test Results\n${buildTestResultsSection(testSummary)}`
    : ''

  const annotationsSection = annotations.length > 0
    ? `\n\n### Annotations (${annotations.length})\n${buildAnnotationsSection(annotations)}`
    : ''

  const warningSection = warningLines.length > 0
    ? `\n\n### Warnings (${warningLines.length})\n${buildWarningsSection(warningLines, warningLinesByCategory, 10)}`
    : ''

  const paramsSection = buildParams.length > 0
    ? `\n\n### Build Parameters\n${buildBuildParamsSection(buildParams)}`
    : ''

  const clonedSection = clonedRepos.length > 0
    ? `\n\n### Cloned Repositories\n${buildClonedReposTable(clonedRepos)}`
    : ''

  const actionsSection = gitRefs.filter(r => r.type === 'action' || r.type === 'docker').length > 0
    ? `\n\n### Actions & Docker Images\n${buildActionsAndImagesTable(gitRefs)}`
    : ''

  return `## Log Analyzer Report

All jobs completed successfully${durationNote}: ${jobsList}${metaLine}${testSection}${annotationsSection}${warningSection}${paramsSection}${clonedSection}${actionsSection}${extra}

---
*[Action Log Analyzer](https://github.com/SKCloudOps/action-log-analyzer) · [Report issue](https://github.com/SKCloudOps/action-log-analyzer/issues)*`
}
