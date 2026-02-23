import * as core from '@actions/core'
import * as github from '@actions/github'
import { loadPatterns, analyzeLogs } from './analyzer'
import { formatPRComment, formatJobSummary, formatSuccessSummary, formatSuccessPRComment } from './formatter'

function extractLinksFromLogs(logs: string): { url: string; label?: string }[] {
  const urlRegex = /https?:\/\/[^\s\)\]\>"\']+/g
  const found = new Set<string>()
  const links: { url: string; label?: string }[] = []
  for (const match of logs.matchAll(urlRegex)) {
    let url = match[0].replace(/[.,;:!?]+$/, '')
    if (url.length > 10 && url.length < 500 && !found.has(url) && !url.includes('github.com')) {
      found.add(url)
      const label = url.includes('coverage') ? 'Coverage report' :
        url.includes('test') || url.includes('report') ? 'Test/report' : undefined
      links.push({ url, label })
    }
  }
  return links.slice(0, 15)  // limit to 15
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

      // Only show completed jobs (exclude in-progress e.g. analyze-logs itself)
      const completedJobs = jobsData.jobs.filter(j => j.conclusion != null)

      // Fetch logs from successful jobs to extract coverage/links
      let extractedLinks: { url: string; label?: string }[] = []
      const successfulJobs = jobsData.jobs.filter(j => j.conclusion === 'success')
      for (const job of successfulJobs.slice(0, 3)) {
        try {
          const logsResponse = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
            owner, repo, job_id: job.id
          })
          const logs = logsResponse.data as unknown as string
          extractedLinks = [...extractedLinks, ...extractLinksFromLogs(logs)]
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

      if (postSummary) {
        const successSummary = formatSuccessSummary(
          runUrl,
          completedJobs,
          triggeredBy,
          branch,
          commit,
          repoFullName,
          artifacts,
          extractedLinks
        )
        await core.summary.addRaw(successSummary).write()
        core.info('Success summary posted.')
      }

      if (postComment && context.payload.pull_request) {
        const prNumber = context.payload.pull_request.number
        const jobNames = completedJobs.map(j => j.name)
        const comment = formatSuccessPRComment(jobNames, runUrl, artifacts, extractedLinks)

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

      // Analyze using pattern matching
      const analysis = await analyzeLogs(logs, patterns, failedStep)

      // Extract notable URLs from logs (coverage, test results, reports, etc.)
      const extractedLinks = extractLinksFromLogs(logs)

      core.info(`Root cause: ${analysis.rootCause}`)
      core.info(`Category: ${analysis.category}`)
      core.info(`Matched pattern: ${analysis.matchedPattern}`)

      // Set outputs
      core.setOutput('root-cause', analysis.rootCause)
      core.setOutput('failed-step', analysis.failedStep)
      core.setOutput('suggestion', analysis.suggestion)
      core.setOutput('matched-pattern', analysis.matchedPattern)
      core.setOutput('category', analysis.category)

      // Post job summary
      if (postSummary) {
        const summary = formatJobSummary(
          analysis, job.name, runUrl,
          job.steps ?? [], triggeredBy, branch, commit, repoFullName,
          artifacts, extractedLinks
        )
        await core.summary.addRaw(summary).write()
        core.info('Job summary posted.')
      }

      // Post PR comment
      if (postComment && context.payload.pull_request) {
        const prNumber = context.payload.pull_request.number
        const comment = formatPRComment(
          analysis, job.name, runUrl,
          job.steps ?? [], repoFullName, branch, commit,
          artifacts, extractedLinks
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
