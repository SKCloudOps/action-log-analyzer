import { FailureAnalysis } from './analyzer'

const MAX_ERROR_LINES = 10

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

export function formatPRComment(analysis: FailureAnalysis, jobName: string, runUrl: string): string {
  const label = SEVERITY_LABEL[analysis.severity]

  const exactMatchBlock = buildErrorContextBlock(analysis)

  const MAX_LINES = 10
  const errorBlock = buildGroupedErrorBlock(analysis.errorLinesByCategory || {}, analysis.exactMatchLine, MAX_LINES, runUrl, analysis.errorLines.length)

  const docsLink = analysis.docsUrl ? `\n\n[Related documentation](${analysis.docsUrl})` : ''

  return `## Log Analyzer Report

| | |
|:--|:--|
| **Job** | \`${jobName}\` |
| **Severity** | ${label} |
| **Logs** | [View full workflow run](${runUrl}) |

> [!CAUTION]
> **Root Cause**
> ${analysis.rootCause}

**Failed Step:** \`${analysis.failedStep}\`${exactMatchBlock}

> [!TIP]
> **Suggested Fix**
> ${analysis.suggestion}${docsLink}
${errorBlock}

---
*[Action Log Analyzer](https://github.com/SKCloudOps/action-log-analyzer) · [Report issue](https://github.com/SKCloudOps/action-log-analyzer/issues)*`
}

export function formatJobSummary(
  analysis: FailureAnalysis,
  jobName: string,
  runUrl: string,
  steps: { name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }[],
  triggeredBy: string,
  branch: string,
  commit: string,
  repo: string
): string {
  const label = SEVERITY_LABEL[analysis.severity]
  const emoji = SEVERITY_EMOJI[analysis.severity]
  const now = new Date().toUTCString()

  // Timeline: compute offset from first step
  const t0 = steps[0]?.started_at ? new Date(steps[0].started_at).getTime() : 0
  const stepRows = steps.map(step => {
    const icon =
      step.conclusion === 'success' ? '✅' :
      step.conclusion === 'failure' ? '❌' :
      step.conclusion === 'skipped' ? '⏭️' :
      step.conclusion === 'cancelled' ? '🚫' : '⏳'

    const duration = step.started_at && step.completed_at
      ? `${Math.round((new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()) / 1000)}s`
      : '—'
    const offset = step.started_at && t0
      ? `+${Math.round((new Date(step.started_at).getTime() - t0) / 1000)}s`
      : '—'

    const isFailedStep = step.name === analysis.failedStep
      ? ' (failed)'
      : ''

    return `| ${icon} | \`${step.name}\` | ${offset} | ${duration} | ${step.conclusion ?? 'in progress'} |${isFailedStep}`
  }).join('\n')

  const patternMeta = `Pattern: \`${analysis.matchedPattern}\` · Category: \`${analysis.category}\``
  const docsLink = analysis.docsUrl ? ` · [Documentation](${analysis.docsUrl})` : ''

  const exactMatchLine = analysis.exactMatchLine || 'No exact match found'
  const before = analysis.contextBefore || []
  const after = analysis.contextAfter || []
  const contextLines: string[] = []
  before.forEach(line => contextLines.push(`   ${line}`))
  if (exactMatchLine) contextLines.push(`>>> ${exactMatchLine}`)
  after.forEach(line => contextLines.push(`   ${line}`))
  const contextBlock = contextLines.length > 0 ? contextLines.join('\n') : exactMatchLine

  return `# Log Analyzer Report

## Summary

| Property | Value |
|:---------|:------|
| Repository | \`${repo}\` |
| Branch | \`${branch}\` |
| Commit | [\`${commit.substring(0, 7)}\`](https://github.com/${repo}/commit/${commit}) |
| Triggered by | \`${triggeredBy}\` |
| Job | \`${jobName}\` |
| Severity | ${emoji} ${label} |
| Log lines scanned | ${analysis.totalLines.toLocaleString()} |
| Analyzed | ${now} |

> [!CAUTION]
> **Root Cause**
> ${analysis.rootCause}
>
> *${patternMeta}*${docsLink}

**Failed Step:** \`${analysis.failedStep}\`

### Error Output
${analysis.exactMatchLineNumber > 0 ? ` *(line ${analysis.exactMatchLineNumber} of ${analysis.totalLines.toLocaleString()})*` : ''}

\`\`\`text
${contextBlock}
\`\`\`

> [!DANGER]
> **Error:** \`${exactMatchLine.replace(/`/g, '\\`').replace(/\n/g, ' ')}\`

> [!TIP]
> **Suggested Fix**
> ${analysis.suggestion}

---

## Timeline

| Status | Step | Offset | Duration | Result |
|:------:|:-----|:------:|:--------:|:-------|
${stepRows}

---

## Error Lines by Category
${buildGroupedErrorBlockSummary(analysis.errorLinesByCategory || {}, analysis.exactMatchLine, MAX_ERROR_LINES, runUrl, analysis.errorLines.length)}

---

## Links

| Action | |
|:-------|:--|
| 🔗 View workflow run | [Open logs](${runUrl}) |
| 📋 Add custom pattern | [patterns.json](https://github.com/${repo}/blob/main/patterns.json) |
| 🐛 Report issue | [Open issue](https://github.com/SKCloudOps/action-log-analyzer/issues) |
| 📖 Documentation | [README](https://github.com/SKCloudOps/action-log-analyzer#readme) |

---
*Action Log Analyzer · ${now}*`
}
