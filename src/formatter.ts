import { FailureAnalysis } from './analyzer'

const SEVERITY_LABEL = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info'
}

export function formatPRComment(analysis: FailureAnalysis, jobName: string, runUrl: string): string {
  const label = SEVERITY_LABEL[analysis.severity]

  const exactMatchBlock = analysis.exactMatchLine
    ? `\n#### Error Output
${analysis.exactMatchLineNumber > 0 ? `*Line ${analysis.exactMatchLineNumber} of ${analysis.totalLines}*  \n` : ''}\`\`\`text
${analysis.exactMatchLine}
\`\`\``
    : ''

  const errorBlock = analysis.errorLines.length > 0
    ? `\n<details>\n<summary>View ${analysis.errorLines.length} detected error line${analysis.errorLines.length === 1 ? '' : 's'}</summary>\n\n\`\`\`text\n${analysis.errorLines.join('\n')}\n\`\`\`\n</details>`
    : ''

  return `## Pipeline Failure Analysis

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
> ${analysis.suggestion}
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
  const now = new Date().toUTCString()

  // Step breakdown
  const stepRows = steps.map(step => {
    const icon =
      step.conclusion === 'success' ? 'ok' :
      step.conclusion === 'failure' ? 'fail' :
      step.conclusion === 'skipped' ? 'skip' :
      step.conclusion === 'cancelled' ? 'cancel' : '--'

    const duration = step.started_at && step.completed_at
      ? `${Math.round((new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()) / 1000)}s`
      : '—'

    const isFailedStep = step.name === analysis.failedStep
      ? ' *(failed)*'
      : ''

    return `| ${icon} | \`${step.name}\` | ${step.conclusion ?? 'in progress'} | ${duration} |${isFailedStep}`
  }).join('\n')

  // Top 10 error lines only in summary
  const topErrorLines = analysis.errorLines
    .slice(0, 10)
    .join('\n')

  const patternMeta = `Pattern: \`${analysis.matchedPattern}\` · Category: \`${analysis.category}\``

  return `# Pipeline Failure Report

## Summary

| Property | Value |
|:---------|:------|
| Repository | \`${repo}\` |
| Branch | \`${branch}\` |
| Commit | [\`${commit.substring(0, 7)}\`](https://github.com/${repo}/commit/${commit}) |
| Triggered by | \`${triggeredBy}\` |
| Job | \`${jobName}\` |
| Severity | ${label} |
| Log lines scanned | ${analysis.totalLines.toLocaleString()} |
| Analyzed | ${now} |

> [!CAUTION]
> **Root Cause**
> ${analysis.rootCause}
>
> *${patternMeta}*

**Failed Step:** \`${analysis.failedStep}\`

### Error Output

${analysis.exactMatchLineNumber > 0
  ? `Line ${analysis.exactMatchLineNumber} of ${analysis.totalLines.toLocaleString()}:`
  : 'Detected error:'}

\`\`\`text
${analysis.exactMatchLine || 'No exact match found'}
\`\`\`

> [!TIP]
> **Suggested Fix**
> ${analysis.suggestion}

---

## Step Breakdown

| Status | Step | Result | Duration |
|:------:|:-----|:-------|:---------|
${stepRows}

---

## Error Lines (showing 10 of ${analysis.errorLines.length})

\`\`\`text
${topErrorLines || 'No error lines captured'}
\`\`\`

---

## Links

| Action | |
|:-------|:--|
| View workflow run | [Open logs](${runUrl}) |
| Add custom pattern | [patterns.json](https://github.com/${repo}/blob/main/patterns.json) |
| Report issue | [Open issue](https://github.com/SKCloudOps/action-log-analyzer/issues) |
| Documentation | [README](https://github.com/SKCloudOps/action-log-analyzer#readme) |

---
*Action Log Analyzer · ${now}*`
}
