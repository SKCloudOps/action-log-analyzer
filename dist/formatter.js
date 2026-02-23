"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatPRComment = formatPRComment;
exports.formatJobSummary = formatJobSummary;
exports.formatSuccessSummary = formatSuccessSummary;
exports.formatSuccessPRComment = formatSuccessPRComment;
const MAX_ERROR_LINES = 10;
function formatDuration(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60)
        return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
function buildGroupedErrorBlock(errorLinesByCategory, exactMatchLine, maxLines, runUrl, totalCount) {
    const categories = Object.keys(errorLinesByCategory).sort();
    if (categories.length === 0)
        return '';
    const parts = [];
    let linesShown = 0;
    const truncated = totalCount > maxLines;
    for (const cat of categories) {
        const lines = errorLinesByCategory[cat];
        const remaining = maxLines - linesShown;
        const showLines = truncated ? lines.slice(0, Math.min(lines.length, Math.max(0, remaining))) : lines;
        const hidden = lines.length - showLines.length;
        const content = showLines
            .map(line => (line === exactMatchLine ? `>>> ${line}` : `   ${line}`))
            .join('\n');
        const suffix = hidden > 0 ? `\n   ... ${hidden} more (see full log)` : '';
        const header = hidden > 0 ? `${cat} (${showLines.length} of ${lines.length})` : `${cat} (${lines.length})`;
        parts.push(`<details>
<summary>${header}</summary>

\`\`\`text
${content}${suffix}
\`\`\`
</details>`);
        linesShown += showLines.length;
        if (linesShown >= maxLines && truncated)
            break;
    }
    const viewFull = truncated ? `\n\n> **[View full log](${runUrl})** — ${totalCount - maxLines} more line${totalCount - maxLines === 1 ? '' : 's'} not shown` : '';
    return `\n${parts.join('\n\n')}${viewFull}`;
}
function buildGroupedErrorBlockSummary(errorLinesByCategory, exactMatchLine, maxLines, runUrl, totalCount) {
    const categories = Object.keys(errorLinesByCategory).sort();
    if (categories.length === 0)
        return '\n*No error lines captured*';
    const parts = [];
    let linesShown = 0;
    const truncated = totalCount > maxLines;
    for (const cat of categories) {
        const lines = errorLinesByCategory[cat];
        const remaining = maxLines - linesShown;
        const showLines = truncated ? lines.slice(0, Math.min(lines.length, Math.max(0, remaining))) : lines;
        const hidden = lines.length - showLines.length;
        const content = showLines
            .map(line => (line === exactMatchLine ? `>>> ${line}` : `   ${line}`))
            .join('\n');
        const suffix = hidden > 0 ? `\n   ... ${hidden} more` : '';
        const header = hidden > 0 ? `${cat} (${showLines.length}/${lines.length})` : `${cat} (${lines.length})`;
        parts.push(`<details>
<summary>${header}</summary>

\`\`\`text
${content}${suffix}
\`\`\`
</details>`);
        linesShown += showLines.length;
        if (linesShown >= maxLines && truncated)
            break;
    }
    const viewFull = truncated ? `\n\n> **[View full log](${runUrl})** — ${totalCount.toLocaleString()} lines total` : '';
    return parts.join('\n\n') + viewFull;
}
function buildErrorContextBlock(analysis) {
    const before = analysis.contextBefore || [];
    const after = analysis.contextAfter || [];
    const exact = analysis.exactMatchLine;
    if (!exact && before.length === 0 && after.length === 0)
        return '';
    const lineRef = analysis.exactMatchLineNumber > 0 ? `*Line ${analysis.exactMatchLineNumber} of ${analysis.totalLines}*` : '';
    const contextLines = [];
    before.forEach(line => contextLines.push(`   ${line}`));
    if (exact)
        contextLines.push(`>>> ${exact}`);
    after.forEach(line => contextLines.push(`   ${line}`));
    return `\n#### Error Output
${lineRef ? `${lineRef}  \n` : ''}\`\`\`text
${contextLines.join('\n')}
\`\`\`

> [!DANGER]
> **Error:** \`${(exact || 'No exact match').replace(/`/g, '\\`').replace(/\n/g, ' ')}\`
`;
}
const SEVERITY_LABEL = {
    critical: 'Critical',
    warning: 'Warning',
    info: 'Info'
};
const SEVERITY_EMOJI = {
    critical: '🔴',
    warning: '🟡',
    info: '🔵'
};
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function buildArtifactsAndLinksSection(runUrl, artifacts, extractedLinks, repo) {
    const parts = [];
    parts.push(`| Link | Description |
|:-----|:------------|
| [View workflow run](${runUrl}) | Full logs & artifact downloads |`);
    if (artifacts.length > 0) {
        for (const a of artifacts) {
            parts.push(`| [\`${a.name}\`](${runUrl}) | Artifact · ${formatBytes(a.size_in_bytes)} |`);
        }
    }
    if (extractedLinks.length > 0) {
        for (const { url, label } of extractedLinks) {
            const display = label || 'Extracted link';
            const shortUrl = url.length > 55 ? url.slice(0, 52) + '…' : url;
            parts.push(`| [${display}](${url}) | ${shortUrl} |`);
        }
    }
    parts.push(`| [Add custom pattern](https://github.com/${repo}/blob/main/patterns.json) | patterns.json |`);
    parts.push(`| [Report issue](https://github.com/SKCloudOps/action-log-analyzer/issues) | Action Log Analyzer |`);
    return parts.join('\n');
}
function formatPRComment(analysis, jobName, runUrl, steps, repo, branch, commit, artifacts = [], extractedLinks = []) {
    const passedCount = steps.filter(s => s.conclusion === 'success').length;
    const totalCount = steps.length;
    const stepBar = steps.map(s => s.conclusion === 'success' ? '🟢' :
        s.conclusion === 'failure' ? '🔴' :
            s.conclusion === 'skipped' ? '⏭️' : '🟡').join('');
    const failedIdx = steps.findIndex(s => s.conclusion === 'failure');
    const commandRows = steps.map((step, i) => {
        const icon = step.conclusion === 'success' ? '✅' : step.conclusion === 'failure' ? '❌' : '⏳';
        const duration = step.started_at && step.completed_at
            ? formatDuration(new Date(step.completed_at).getTime() - new Date(step.started_at).getTime())
            : '—';
        const failedMarker = i === failedIdx ? '\n                                             ↑ FAILED HERE' : '';
        return `| ${i + 1} | ${step.name} | ${icon} | ${duration} |${failedMarker}`;
    }).join('\n');
    const exactMatchLine = (analysis.exactMatchLine || 'No exact match').replace(/`/g, '\\`').replace(/\n/g, ' ');
    const docsLink = analysis.docsUrl ? `\n\n[Related documentation](${analysis.docsUrl})` : '';
    const MAX_LINES = 10;
    const errorBlock = buildGroupedErrorBlock(analysis.errorLinesByCategory || {}, analysis.exactMatchLine, MAX_LINES, runUrl, analysis.errorLines.length);
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

### Artifacts & Links
${buildArtifactsAndLinksSection(runUrl, artifacts, extractedLinks, repo)}

---
*[Action Log Analyzer](https://github.com/SKCloudOps/action-log-analyzer)*`;
}
function formatJobSummary(analysis, jobName, runUrl, steps, triggeredBy, branch, commit, repo, artifacts = [], extractedLinks = []) {
    const label = SEVERITY_LABEL[analysis.severity];
    const emoji = SEVERITY_EMOJI[analysis.severity];
    const now = new Date().toUTCString();
    const patternMeta = `Pattern: \`${analysis.matchedPattern}\` · Category: \`${analysis.category}\``;
    const docsLink = analysis.docsUrl ? `\n\n[Documentation](${analysis.docsUrl})` : '';
    const passedCount = steps.filter(s => s.conclusion === 'success').length;
    const totalCount = steps.length;
    const stepBar = steps.map(s => s.conclusion === 'success' ? '🟢' :
        s.conclusion === 'failure' ? '🔴' :
            s.conclusion === 'skipped' ? '⏭️' : '🟡').join('');
    const failedIdx = steps.findIndex(s => s.conclusion === 'failure');
    const commandRows = steps.map((step, i) => {
        const icon = step.conclusion === 'success' ? '✅' : step.conclusion === 'failure' ? '❌' : '⏳';
        const duration = step.started_at && step.completed_at
            ? formatDuration(new Date(step.completed_at).getTime() - new Date(step.started_at).getTime())
            : '—';
        const failedMarker = i === failedIdx ? '\n                                             ↑ FAILED HERE' : '';
        return `| ${i + 1} | ${step.name} | ${icon} | ${duration} |${failedMarker}`;
    }).join('\n');
    const exactMatchLine = (analysis.exactMatchLine || 'No exact match').replace(/`/g, '\\`').replace(/\n/g, ' ');
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

## Artifacts & Links
${buildArtifactsAndLinksSection(runUrl, artifacts, extractedLinks, repo)}

---
*Action Log Analyzer · ${now}*`;
}
function formatSuccessSummary(runUrl, jobs, triggeredBy, branch, commit, repo, artifacts = [], extractedLinks = []) {
    const now = new Date().toUTCString();
    const jobRows = jobs.map(job => {
        const icon = job.conclusion === 'success' ? '✅' : job.conclusion === 'failure' ? '❌' : '⏳';
        return `| ${icon} | \`${job.name}\` | ${job.conclusion ?? 'in progress'} |`;
    }).join('\n');
    const totalSteps = jobs.reduce((sum, j) => sum + (j.steps?.length ?? 0), 0);
    const passedSteps = jobs.reduce((sum, j) => sum + (j.steps?.filter(s => s.conclusion === 'success').length ?? 0), 0);
    const stepBar = jobs.flatMap(j => j.steps ?? []).map(s => s.conclusion === 'success' ? '🟢' : s.conclusion === 'failure' ? '🔴' : '🟡').join('');
    const stepBarDisplay = stepBar ? `\n\n${stepBar}  **${passedSteps}/${totalSteps} steps passed**` : '';
    let timelineSection = '';
    const allSteps = [];
    for (const job of jobs) {
        for (const step of job.steps ?? []) {
            allSteps.push({ jobName: job.name, step });
        }
    }
    if (allSteps.length > 0) {
        const stepRows = allSteps.map(({ jobName, step }, i) => {
            const icon = step.conclusion === 'success' ? '✅' : step.conclusion === 'failure' ? '❌' : '⏳';
            const duration = step.started_at && step.completed_at
                ? formatDuration(new Date(step.completed_at).getTime() - new Date(step.started_at).getTime())
                : '—';
            return `| ${i + 1} | \`${step.name}\` | ${jobName} | ${icon} | ${duration} |`;
        }).join('\n');
        timelineSection = `

### Command Timeline
| # | Step | Job | Status | Duration |
|:--|:-----|:----|:------:|:---------|
${stepRows}`;
    }
    const coverageLinks = extractedLinks.filter(l => l.label === 'Coverage report');
    const reportLinks = extractedLinks.filter(l => l.label && l.label !== 'Coverage report');
    let coverageSection = '';
    if (coverageLinks.length > 0 || reportLinks.length > 0) {
        const parts = [];
        if (coverageLinks.length > 0) {
            parts.push(`| Coverage | ${coverageLinks.map(l => `[${l.label}](${l.url})`).join(' · ')} |`);
        }
        if (reportLinks.length > 0) {
            parts.push(`| Reports | ${reportLinks.slice(0, 5).map(l => `[${l.label}](${l.url})`).join(' · ')} |`);
        }
        coverageSection = `

### Coverage & Reports
| Type | Link |
|:-----|:-----|
${parts.join('\n')}`;
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
${coverageSection}

### Artifacts & Links
${buildArtifactsAndLinksSection(runUrl, artifacts, extractedLinks, repo)}

---
*Action Log Analyzer · ${now}*`;
}
function formatSuccessPRComment(jobNames, runUrl, artifacts = [], extractedLinks = []) {
    const jobsList = jobNames.map(n => `\`${n}\``).join(', ');
    let extra = `\n\n[View workflow run](${runUrl})`;
    if (artifacts.length > 0 || extractedLinks.length > 0) {
        const parts = [];
        if (artifacts.length > 0) {
            parts.push(`**Artifacts:** ${artifacts.map(a => `\`${a.name}\` (${Math.round(a.size_in_bytes / 1024)} KB)`).join(', ')}`);
        }
        if (extractedLinks.length > 0) {
            const coverage = extractedLinks.filter(l => l.label === 'Coverage report');
            if (coverage.length > 0) {
                parts.push(`**Coverage:** ${coverage.map(l => `[${l.label}](${l.url})`).join(', ')}`);
            }
            const other = extractedLinks.filter(l => !l.label || l.label !== 'Coverage report');
            if (other.length > 0) {
                parts.push(`**Links:** ${other.slice(0, 5).map(l => `[${l.label || 'link'}](${l.url})`).join(', ')}`);
            }
        }
        extra = `\n\n${parts.join('\n\n')}\n\n[View workflow run & download](${runUrl})`;
    }
    return `## Log Analyzer Report

All jobs completed successfully: ${jobsList}${extra}

---
*[Action Log Analyzer](https://github.com/SKCloudOps/action-log-analyzer) · [Report issue](https://github.com/SKCloudOps/action-log-analyzer/issues)*`;
}
