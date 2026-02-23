import { FailureAnalysis, BuildParam, GitRef, ClonedRepo } from './analyzer'

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
  clonedRepos: ClonedRepo[] = []
): string {
  const passedCount = steps.filter(s => s.conclusion === 'success').length
  const totalCount = steps.length
  const stepBar = steps.map(s =>
    s.conclusion === 'success' ? '🟢' :
    s.conclusion === 'failure' ? '🔴' :
    s.conclusion === 'skipped' ? '⏭️' : '🟡'
  ).join('')

  const failedIdx = steps.findIndex(s => s.conclusion === 'failure')
  const commandRows = steps.map((step, i) => {
    const icon = step.conclusion === 'success' ? '✅' : step.conclusion === 'failure' ? '❌' : '⏳'
    const duration = step.started_at && step.completed_at
      ? formatDuration(new Date(step.completed_at).getTime() - new Date(step.started_at).getTime())
      : '—'
    const failedMarker = i === failedIdx ? '\n                                             ↑ FAILED HERE' : ''
    return `| ${i + 1} | ${step.name} | ${icon} | ${duration} |${failedMarker}`
  }).join('\n')

  const exactMatchLine = (analysis.exactMatchLine || 'No exact match').replace(/`/g, '\\`').replace(/\n/g, ' ')
  const docsLink = analysis.docsUrl ? `\n\n[Related documentation](${analysis.docsUrl})` : ''

  const MAX_LINES = 10
  const errorBlock = buildGroupedErrorBlock(analysis.errorLinesByCategory || {}, analysis.exactMatchLine, MAX_LINES, runUrl, analysis.errorLines.length)

  return `## Action Log Analyzer — ${jobName} Build Report

\`${repo}\` · \`${branch}\` · \`${commit.substring(0, 7)}\`

${stepBar}  **${passedCount}/${totalCount} steps passed**

### Health Scorecard
| Category | Score | Value | Status |
|:---------|:------|:------|:-------|
| Build | ${analysis.category} | ${analysis.totalLines.toLocaleString()} lines | ${SEVERITY_EMOJI[analysis.severity]} ${SEVERITY_LABEL[analysis.severity]} |
| Pattern | \`${analysis.matchedPattern}\` | ${analysis.errorLines.length} error lines | matched |

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
${analysis.warningLines.length > 0 ? `
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
  clonedRepos: ClonedRepo[] = []
): string {
  const label = SEVERITY_LABEL[analysis.severity]
  const emoji = SEVERITY_EMOJI[analysis.severity]
  const now = new Date().toUTCString()

  const patternMeta = `Pattern: \`${analysis.matchedPattern}\` · Category: \`${analysis.category}\``
  const docsLink = analysis.docsUrl ? `\n\n[Documentation](${analysis.docsUrl})` : ''

  const passedCount = steps.filter(s => s.conclusion === 'success').length
  const totalCount = steps.length
  const stepBar = steps.map(s =>
    s.conclusion === 'success' ? '🟢' :
    s.conclusion === 'failure' ? '🔴' :
    s.conclusion === 'skipped' ? '⏭️' : '🟡'
  ).join('')

  const failedIdx = steps.findIndex(s => s.conclusion === 'failure')
  const commandRows = steps.map((step, i) => {
    const icon = step.conclusion === 'success' ? '✅' : step.conclusion === 'failure' ? '❌' : '⏳'
    const duration = step.started_at && step.completed_at
      ? formatDuration(new Date(step.completed_at).getTime() - new Date(step.started_at).getTime())
      : '—'
    const failedMarker = i === failedIdx ? '\n                                             ↑ FAILED HERE' : ''
    return `| ${i + 1} | ${step.name} | ${icon} | ${duration} |${failedMarker}`
  }).join('\n')

  const exactMatchLine = (analysis.exactMatchLine || 'No exact match').replace(/`/g, '\\`').replace(/\n/g, ' ')

  return `# Action Log Analyzer — ${jobName} Build Report

\`${repo}\` · \`${branch}\` · [\`${commit.substring(0, 7)}\`](https://github.com/${repo}/commit/${commit})

${stepBar}  **${passedCount}/${totalCount} steps passed**

## Health Scorecard
| Category | Score | Value | Status |
|:---------|:------|:------|:-------|
| Build | ${analysis.category} | ${analysis.totalLines.toLocaleString()} lines | ${emoji} ${label} |
| Pattern | \`${analysis.matchedPattern}\` | ${analysis.errorLines.length} error lines | matched |

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
${analysis.warningLines.length > 0 ? `
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
  jobs: { name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }[] }[],
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
  clonedRepos: ClonedRepo[] = []
): string {
  const now = new Date().toUTCString()

  const jobRows = jobs.map(job => {
    const icon = job.conclusion === 'success' ? '✅' : job.conclusion === 'failure' ? '❌' : '⏳'
    return `| ${icon} | \`${job.name}\` | ${job.conclusion ?? 'in progress'} |`
  }).join('\n')

  const totalSteps = jobs.reduce((sum, j) => sum + (j.steps?.length ?? 0), 0)
  const passedSteps = jobs.reduce((sum, j) => sum + (j.steps?.filter(s => s.conclusion === 'success').length ?? 0), 0)
  const stepBar = jobs.flatMap(j => j.steps ?? []).map(s =>
    s.conclusion === 'success' ? '🟢' : s.conclusion === 'failure' ? '🔴' : '🟡'
  ).join('')
  const stepBarDisplay = stepBar ? `\n\n${stepBar}  **${passedSteps}/${totalSteps} steps passed**` : ''

  let timelineSection = ''
  const allSteps: { jobName: string; step: { name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null } }[] = []
  for (const job of jobs) {
    for (const step of job.steps ?? []) {
      allSteps.push({ jobName: job.name, step })
    }
  }
  if (allSteps.length > 0) {
    const stepRows = allSteps.map(({ jobName, step }, i) => {
      const icon = step.conclusion === 'success' ? '✅' : step.conclusion === 'failure' ? '❌' : '⏳'
      const duration = step.started_at && step.completed_at
        ? formatDuration(new Date(step.completed_at).getTime() - new Date(step.started_at).getTime())
        : '—'
      return `| ${i + 1} | \`${step.name}\` | ${jobName} | ${icon} | ${duration} |`
    }).join('\n')
    timelineSection = `

### Command Timeline
| # | Step | Job | Status | Duration |
|:--|:-----|:----|:------:|:---------|
${stepRows}`
  }

  return `# Log Analyzer Report

## All Jobs Passed

\`${repo}\` · \`${branch}\` · [\`${commit.substring(0, 7)}\`](https://github.com/${repo}/commit/${commit})${stepBarDisplay}

### Job Summary
| Status | Job | Result |
|:------:|:----|:-------|
${jobRows}

### Run Overview
| Property | Value |
|:---------|:------|
| Repository | \`${repo}\` |
| Branch | \`${branch}\` |
| Commit | [\`${commit.substring(0, 7)}\`](https://github.com/${repo}/commit/${commit}) |
| Triggered by | \`${triggeredBy}\` |
| Jobs passed | ${jobs.length} |
| Steps completed | ${passedSteps}/${totalSteps} |
${timelineSection}

${warningLines.length > 0 ? `### Warnings (${warningLines.length})
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
  clonedRepos: ClonedRepo[] = []
): string {
  const jobsList = jobNames.map(n => `\`${n}\``).join(', ')
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

All jobs completed successfully: ${jobsList}${warningSection}${paramsSection}${clonedSection}${actionsSection}${extra}

---
*[Action Log Analyzer](https://github.com/SKCloudOps/action-log-analyzer) · [Report issue](https://github.com/SKCloudOps/action-log-analyzer/issues)*`
}
