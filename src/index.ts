import * as core from '@actions/core'
import * as github from '@actions/github'
import { loadPatterns, analyzeLogs, extractBuildParams, extractGitRefsFromLogs, extractGitRefsFromSteps, extractClonedRepos, computeJobTiming, extractTestResults, extractAnnotations, BuildParam, GitRef, ClonedRepo, JobTiming, TestSummary, Annotation } from './analyzer'
import { formatPRComment, formatJobSummary, formatSuccessSummary, formatSuccessPRComment } from './formatter'

function formatDurationIndex(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function cleanLogLine(raw: string): string {
  return raw
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '')
    .replace(/\x1b\[[0-9;]*[mGKHF]/g, '')
    .replace(/##\[(?:error|warning|debug|group|endgroup)\]/g, '')
    .trim()
}

function extractWarningsFromLogs(logs: string): string[] {
  const lines = logs.split('\n')
  const warnings: string[] = []
  for (const raw of lines) {
    const cleaned = cleanLogLine(raw)
    if (cleaned.length === 0) continue
    if (/\bwarn(ing)?\b|WARN|⚠/i.test(cleaned) && !/^\s*\d+\s+warn(ing)?s?\s*$/i.test(cleaned)) {
      if (!/error|failed|fatal|exception|FAIL|ERR!/i.test(cleaned)) {
        warnings.push(cleaned)
      }
    }
  }
  return warnings
}

function categorizeWarnings(warningLines: string[]): Record<string, string[]> {
  const byCategory: Record<string, string[]> = {}
  for (const line of warningLines) {
    let cat = 'General'
    if (/deprecat/i.test(line)) cat = 'Deprecation'
    else if (/npm\s+warn|npm\s+WARN/i.test(line)) cat = 'npm'
    else if (/pip|python|setuptools/i.test(line)) cat = 'Python'
    else if (/docker/i.test(line)) cat = 'Docker'
    else if (/security|vuln/i.test(line)) cat = 'Security'
    else if (/permission|access/i.test(line)) cat = 'Permissions'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(line)
  }
  return byCategory
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.length > 30 ? url.slice(0, 27) + '...' : url
  }
}

// github.com URLs allowed through — everything else on github.com is dropped
const GITHUB_ALLOW_PATTERNS = [
  /github\.com\/[^/]+\/[^/]+\/releases\/download\//i,
  /github\.com\/[^/]+\/[^/]+\/suites\/.*\/artifacts/i,
  /github\.com\/[^/]+\/[^/]+\/actions\/artifacts/i,
]

const LABEL_MATCHERS: { test: RegExp; label: string }[] = [
  { test: /\.jfrog\.(io|com)|artifactory/i,                    label: 'Artifactory' },
  { test: /nexus|sonatype/i,                                    label: 'Nexus' },
  { test: /s3\.amazonaws\.com|s3-[a-z-]+\.amazonaws/i,         label: 'S3 artifact' },
  { test: /storage\.googleapis\.com|storage\.cloud\.google/i,   label: 'GCS artifact' },
  { test: /blob\.core\.windows\.net|azurewebsites/i,            label: 'Azure artifact' },
  { test: /\.azurecr\.io/i,                                     label: 'Azure Container Registry' },
  { test: /registry\.npmjs\.org/i,                               label: 'npm registry' },
  { test: /pypi\.org|files\.pythonhosted/i,                      label: 'PyPI' },
  { test: /registry-1\.docker\.io|hub\.docker\.com/i,            label: 'Docker Hub' },
  { test: /ghcr\.io/i,                                           label: 'GitHub Container Registry' },
  { test: /gcr\.io/i,                                            label: 'Google Container Registry' },
  { test: /\.ecr\.[a-z-]+\.amazonaws\.com/i,                     label: 'ECR' },
  { test: /github\.com\/.*\/releases\/download/i,                label: 'GitHub Release' },
  { test: /github\.com\/.*\/artifacts/i,                         label: 'GitHub Artifact' },
  { test: /codecov\.io/i,                                        label: 'Codecov' },
  { test: /coveralls\.io/i,                                      label: 'Coveralls' },
  { test: /sonarcloud\.io|sonarqube/i,                           label: 'SonarCloud' },
  { test: /snyk\.io/i,                                           label: 'Snyk' },
]

function classifyUrl(url: string): string {
  for (const { test, label } of LABEL_MATCHERS) {
    if (test.test(url)) return label
  }
  return extractDomain(url)
}

function isUsefulUrl(url: string): boolean {
  if (url.length <= 10 || url.length >= 500) return false
  if (/github\.com/i.test(url)) {
    return GITHUB_ALLOW_PATTERNS.some(p => p.test(url))
  }
  if (/api\.github\.com/i.test(url)) return false
  return true
}

function extractLinksFromLogs(logs: string): { url: string; label: string }[] {
  const urlRegex = /https?:\/\/[^\s\)\]\>"\']+/g
  const found = new Set<string>()
  const links: { url: string; label: string }[] = []
  for (const match of logs.matchAll(urlRegex)) {
    const url = match[0].replace(/[.,;:!?]+$/, '')
    if (found.has(url) || !isUsefulUrl(url)) continue
    found.add(url)
    links.push({ url, label: classifyUrl(url) })
  }
  return links.slice(0, 20)
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true })
    const postComment = core.getInput('post-comment') === 'true'
    const postSummary = core.getInput('post-summary') === 'true'
    const failedJobName = core.getInput('failed-job-name')
    const remotePatternsUrl = core.getInput('remote-patterns-url')

    const octokit = github.getOctokit(token)
    const context = github.context
    const { owner, repo } = context.repo

    core.info('Action Log Analyzer: Starting failure analysis...')

    // Load patterns — local + optional remote
    const patterns = await loadPatterns(remotePatternsUrl || undefined)

    const runId = context.runId
    const runUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`
    const branch = context.ref.replace('refs/heads/', '')
    let artifacts: { name: string; size_in_bytes: number; url: string }[] = []

    try {
      const { data: artifactsData } = await octokit.rest.actions.listWorkflowRunArtifacts({
        owner, repo, run_id: runId
      })
      artifacts = (artifactsData.artifacts || [])
        .filter(a => !a.expired)
        .map(a => ({ name: a.name, size_in_bytes: a.size_in_bytes, url: a.url }))
    } catch (err) {
      core.warning(`Could not fetch artifacts: ${err}`)
    }
    const commit = context.sha
    const triggeredBy = context.actor
    const repoFullName = `${owner}/${repo}`

    const runAttempt = parseInt(process.env.GITHUB_RUN_ATTEMPT || '1', 10)
    const runNumber = parseInt(process.env.GITHUB_RUN_NUMBER || '0', 10)
    const triggerEvent = context.eventName || ''
    const workflowName = process.env.GITHUB_WORKFLOW || ''

    if (runAttempt > 1) {
      core.info(`This is attempt #${runAttempt} of run #${runNumber}`)
    }

    const { data: jobsData } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner, repo, run_id: runId
    })

    const failedJobs = jobsData.jobs.filter(job => {
      const isFailed = job.conclusion === 'failure'
      if (failedJobName) return isFailed && job.name === failedJobName
      return isFailed
    })

    if (failedJobs.length === 0) {
      core.info('No failed jobs. Posting success summary.')

      const completedJobs = jobsData.jobs.filter(j => j.conclusion != null)

      const allTimings: JobTiming[] = completedJobs.map(j => computeJobTiming(j as any))

      let extractedLinks: { url: string; label?: string }[] = []
      let allWarnings: string[] = []
      let allBuildParams: BuildParam[] = []
      let allGitRefs: GitRef[] = []
      let allClonedRepos: ClonedRepo[] = []
      let allTestSummary: TestSummary | null = null
      let allAnnotations: Annotation[] = []
      const successfulJobs = jobsData.jobs.filter(j => j.conclusion === 'success')
      for (const job of successfulJobs.slice(0, 3)) {
        try {
          const logsResponse = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
            owner, repo, job_id: job.id
          })
          const logs = logsResponse.data as unknown as string
          const logLines = logs.split('\n')
          extractedLinks = [...extractedLinks, ...extractLinksFromLogs(logs)]
          allWarnings = [...allWarnings, ...extractWarningsFromLogs(logs)]
          allBuildParams = [...allBuildParams, ...extractBuildParams(logLines)]
          allGitRefs = [...allGitRefs, ...extractGitRefsFromLogs(logLines)]
          allGitRefs = [...allGitRefs, ...extractGitRefsFromSteps(job.steps ?? [], logs)]
          allClonedRepos = [...allClonedRepos, ...extractClonedRepos(logLines)]
          allAnnotations = [...allAnnotations, ...extractAnnotations(logLines)]
          if (!allTestSummary) {
            allTestSummary = extractTestResults(logLines)
          }
          const seen = new Set<string>()
          extractedLinks = extractedLinks.filter(l => {
            if (seen.has(l.url)) return false
            seen.add(l.url)
            return true
          }).slice(0, 15)
        } catch {
          /* skip if logs unavailable */
        }
      }

      allWarnings = [...new Set(allWarnings)]
      const seenParams = new Set<string>()
      allBuildParams = allBuildParams.filter(p => {
        const uid = `${p.key}=${p.value}`
        if (seenParams.has(uid)) return false
        seenParams.add(uid)
        return true
      }).slice(0, 30)
      const seenRefs = new Set<string>()
      allGitRefs = allGitRefs.filter(r => {
        const uid = `${r.type}:${r.repo}@${r.ref}`
        if (seenRefs.has(uid)) return false
        seenRefs.add(uid)
        return true
      }).slice(0, 40)
      const seenCloned = new Set<string>()
      allClonedRepos = allClonedRepos.filter(r => {
        if (seenCloned.has(r.repository)) return false
        seenCloned.add(r.repository)
        return true
      }).slice(0, 20)
      const seenAnno = new Set<string>()
      allAnnotations = allAnnotations.filter(a => {
        const uid = `${a.level}:${a.message}`
        if (seenAnno.has(uid)) return false
        seenAnno.add(uid)
        return true
      }).slice(0, 30)

      const warningLinesByCategory = categorizeWarnings(allWarnings)

      if (allWarnings.length > 0) {
        core.info(`Found ${allWarnings.length} warning(s) in successful job logs`)
      }
      if (allBuildParams.length > 0) {
        core.info(`Detected ${allBuildParams.length} build parameter(s)`)
      }
      if (allGitRefs.length > 0) {
        core.info(`Detected ${allGitRefs.length} action/docker reference(s)`)
      }
      if (allClonedRepos.length > 0) {
        core.info(`Detected ${allClonedRepos.length} cloned repository(ies)`)
      }
      if (allTestSummary) {
        core.info(`Test results: ${allTestSummary.passed} passed, ${allTestSummary.failed} failed (${allTestSummary.framework})`)
      }
      if (allAnnotations.length > 0) {
        core.info(`Collected ${allAnnotations.length} annotation(s)`)
      }

      const totalDurationMs = allTimings.reduce((sum, t) => sum + t.jobDurationMs, 0)

      if (postSummary) {
        const successSummary = formatSuccessSummary(
          runUrl,
          completedJobs as any,
          triggeredBy,
          branch,
          commit,
          repoFullName,
          artifacts,
          extractedLinks,
          allWarnings,
          warningLinesByCategory,
          allBuildParams,
          allGitRefs,
          allClonedRepos,
          allTimings,
          allTestSummary,
          allAnnotations,
          runAttempt,
          runNumber,
          triggerEvent,
          workflowName
        )
        await core.summary.addRaw(successSummary).write()
        core.info('Success summary posted.')
      }

      if (postComment && context.payload.pull_request) {
        const prNumber = context.payload.pull_request.number
        const jobNames = completedJobs.map(j => j.name)
        const comment = formatSuccessPRComment(
          jobNames, runUrl, artifacts, extractedLinks,
          allWarnings, warningLinesByCategory, allBuildParams, allGitRefs, allClonedRepos,
          allTimings, allTestSummary, allAnnotations,
          runAttempt, runNumber, triggerEvent, workflowName
        )

        const { data: comments } = await octokit.rest.issues.listComments({
          owner, repo, issue_number: prNumber
        })

        const existingComment = comments.find(c =>
          c.body?.includes('Log Analyzer Report') &&
          c.body?.includes('All jobs completed successfully')
        )

        if (existingComment) {
          await octokit.rest.issues.updateComment({
            owner, repo, comment_id: existingComment.id, body: comment
          })
          core.info('Updated existing PR comment.')
        } else {
          await octokit.rest.issues.createComment({
            owner, repo, issue_number: prNumber, body: comment
          })
          core.info('Posted PR comment.')
        }
      }

      core.setOutput('root-cause', '')
      core.setOutput('failed-step', '')
      core.setOutput('suggestion', '')
      core.setOutput('matched-pattern', 'none')
      core.setOutput('category', 'Success')
      core.setOutput('warning-count', String(allWarnings.length))
      core.setOutput('build-params', JSON.stringify(allBuildParams))
      core.setOutput('git-refs', JSON.stringify(allGitRefs))
      core.setOutput('total-duration', totalDurationMs > 0 ? formatDurationIndex(totalDurationMs) : '')
      const globalSlowest = allTimings.reduce<{ name: string; ms: number }>((best, t) => {
        if (t.slowestStep && t.slowestStep.durationMs > best.ms) return { name: t.slowestStep.name, ms: t.slowestStep.durationMs }
        return best
      }, { name: '', ms: 0 })
      core.setOutput('slowest-step', globalSlowest.name)
      core.setOutput('test-summary', allTestSummary ? JSON.stringify(allTestSummary) : '')
      core.setOutput('run-attempt', String(runAttempt))
      core.setOutput('run-number', String(runNumber))
      core.setOutput('trigger-event', triggerEvent)
      core.info('Action Log Analyzer complete.')
      return
    }

    core.info(`Found ${failedJobs.length} failed job(s). Analyzing...`)

    for (const job of failedJobs) {
      core.info(`Analyzing job: ${job.name}`)

      let logs = ''
      try {
        const logsResponse = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
          owner, repo, job_id: job.id
        })
        logs = logsResponse.data as unknown as string
      } catch (err) {
        core.warning(`Could not fetch logs for job ${job.name}: ${err}`)
        logs = job.steps
          ?.filter(s => s.conclusion === 'failure')
          .map(s => `Step failed: ${s.name}`)
          .join('\n') || ''
      }

      const failedStep = job.steps?.find(s => s.conclusion === 'failure')?.name

      const analysis = await analyzeLogs(logs, patterns, failedStep)

      const extractedLinks = extractLinksFromLogs(logs)

      const logLines = logs.split('\n')
      let jobGitRefs = [
        ...extractGitRefsFromLogs(logLines),
        ...extractGitRefsFromSteps(job.steps ?? [], logs)
      ]
      const seenJobRefs = new Set<string>()
      jobGitRefs = jobGitRefs.filter(r => {
        const uid = `${r.type}:${r.repo}@${r.ref}`
        if (seenJobRefs.has(uid)) return false
        seenJobRefs.add(uid)
        return true
      }).slice(0, 40)
      const jobClonedRepos = extractClonedRepos(logLines)

      const jobTiming = computeJobTiming(job as any)
      const jobTestSummary = extractTestResults(logLines)
      const jobAnnotations = extractAnnotations(logLines)

      core.info(`Root cause: ${analysis.rootCause}`)
      core.info(`Category: ${analysis.category}`)
      core.info(`Matched pattern: ${analysis.matchedPattern}`)
      if (jobTiming.jobDurationMs > 0) {
        core.info(`Job duration: ${formatDurationIndex(jobTiming.jobDurationMs)}${jobTiming.slowestStep ? `, slowest step: ${jobTiming.slowestStep.name}` : ''}`)
      }
      if (jobTestSummary) {
        core.info(`Test results: ${jobTestSummary.passed} passed, ${jobTestSummary.failed} failed (${jobTestSummary.framework})`)
      }
      if (jobAnnotations.length > 0) {
        core.info(`Collected ${jobAnnotations.length} annotation(s)`)
      }
      if (jobGitRefs.length > 0) {
        core.info(`Detected ${jobGitRefs.length} action/docker reference(s)`)
      }
      if (jobClonedRepos.length > 0) {
        core.info(`Detected ${jobClonedRepos.length} cloned repository(ies)`)
      }

      core.setOutput('root-cause', analysis.rootCause)
      core.setOutput('failed-step', analysis.failedStep)
      core.setOutput('suggestion', analysis.suggestion)
      core.setOutput('matched-pattern', analysis.matchedPattern)
      core.setOutput('category', analysis.category)
      core.setOutput('warning-count', String(analysis.warningLines.length))
      core.setOutput('build-params', JSON.stringify(analysis.buildParams))
      core.setOutput('git-refs', JSON.stringify(jobGitRefs))
      core.setOutput('total-duration', jobTiming.jobDurationMs > 0 ? formatDurationIndex(jobTiming.jobDurationMs) : '')
      core.setOutput('slowest-step', jobTiming.slowestStep?.name ?? '')
      core.setOutput('test-summary', jobTestSummary ? JSON.stringify(jobTestSummary) : '')
      core.setOutput('run-attempt', String(runAttempt))
      core.setOutput('run-number', String(runNumber))
      core.setOutput('trigger-event', triggerEvent)

      if (postSummary) {
        const summary = formatJobSummary(
          analysis, job.name, runUrl,
          job.steps ?? [], triggeredBy, branch, commit, repoFullName,
          artifacts, extractedLinks, jobGitRefs, jobClonedRepos,
          jobTiming, jobTestSummary, jobAnnotations,
          runAttempt, runNumber, triggerEvent, workflowName
        )
        await core.summary.addRaw(summary).write()
        core.info('Job summary posted.')
      }

      if (postComment && context.payload.pull_request) {
        const prNumber = context.payload.pull_request.number
        const comment = formatPRComment(
          analysis, job.name, runUrl,
          job.steps ?? [], repoFullName, branch, commit,
          artifacts, extractedLinks, jobGitRefs, jobClonedRepos,
          jobTiming, jobTestSummary, jobAnnotations,
          runAttempt, runNumber, triggerEvent, workflowName
        )

        const { data: comments } = await octokit.rest.issues.listComments({
          owner, repo, issue_number: prNumber
        })

        const existingComment = comments.find(c =>
          c.body?.includes('Log Analyzer Report') &&
          c.body?.includes(job.name)
        )

        if (existingComment) {
          await octokit.rest.issues.updateComment({
            owner, repo, comment_id: existingComment.id, body: comment
          })
          core.info('Updated existing PR comment.')
        } else {
          await octokit.rest.issues.createComment({
            owner, repo, issue_number: prNumber, body: comment
          })
          core.info('Posted PR comment.')
        }
      }
    }

    core.info('Action Log Analyzer analysis complete.')
  } catch (error) {
    core.setFailed(`Action Log Analyzer failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

run()
