import * as fs from 'fs'
import * as path from 'path'
import * as core from '@actions/core'

export interface FailureAnalysis {
  rootCause: string
  failedStep: string
  suggestion: string
  errorLines: string[]
  errorLinesByCategory: Record<string, string[]>
  warningLines: string[]
  warningLinesByCategory: Record<string, string[]>
  exactMatchLine: string
  exactMatchLineNumber: number
  contextBefore: string[]
  contextAfter: string[]
  totalLines: number
  severity: 'critical' | 'warning' | 'info'
  matchedPattern: string
  category: string
  docsUrl?: string
  buildParams: BuildParam[]
}

export interface BuildParam {
  key: string
  value: string
  source: string
}

export interface GitRef {
  repo: string
  ref: string
  type: 'action' | 'docker' | 'git-checkout' | 'submodule'
}

export interface ClonedRepo {
  repository: string
  branch: string
  commit: string
  depth: string
}

interface ErrorPattern {
  id: string
  category: string
  pattern: string
  flags: string
  rootCause: string
  suggestion: string
  severity: 'critical' | 'warning' | 'info'
  tags: string[]
  docsUrl?: string
}

interface PatternsFile {
  version: string
  patterns: ErrorPattern[]
}

// Strip GitHub Actions log timestamps and ANSI color codes
function cleanLine(raw: string): string {
  return raw
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '') // remove timestamp: 2026-02-22T19:12:50.8020453Z
    .replace(/\x1b\[[0-9;]*[mGKHF]/g, '')            // remove ANSI color codes: \u001b[36;1m
    .replace(/##\[(?:error|warning|debug|group|endgroup)\]/g, '') // remove GHA annotations
    .trim()
}

function loadLocalPatterns(): ErrorPattern[] {
  const localPath = path.join(__dirname, '..', 'patterns.json')
  try {
    if (fs.existsSync(localPath)) {
      const raw = fs.readFileSync(localPath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown as PatternsFile
      core.info(`Loaded ${parsed.patterns.length} patterns from patterns.json (v${parsed.version})`)
      return parsed.patterns
    }
  } catch (err) {
    core.warning(`Could not load local patterns.json: ${err}`)
  }
  return []
}

async function fetchRemotePatterns(remoteUrl: string): Promise<ErrorPattern[]> {
  try {
    core.info(`Fetching remote patterns from ${remoteUrl}...`)
    const response = await fetch(remoteUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) {
      core.warning(`Remote patterns fetch failed: HTTP ${response.status}`)
      return []
    }
    const parsed = await response.json() as unknown as PatternsFile
    core.info(`Loaded ${parsed.patterns.length} remote patterns (v${parsed.version})`)
    return parsed.patterns
  } catch (err) {
    core.warning(`Could not fetch remote patterns: ${err}`)
    return []
  }
}

function mergePatterns(local: ErrorPattern[], remote: ErrorPattern[]): ErrorPattern[] {
  const localIds = new Set(local.map(p => p.id))
  const remoteOnly = remote.filter(p => !localIds.has(p.id))
  const merged = [...local, ...remoteOnly]
  core.info(`Using ${merged.length} total patterns (${local.length} local + ${remoteOnly.length} remote)`)
  return merged
}

export async function loadPatterns(remoteUrl?: string): Promise<ErrorPattern[]> {
  const local = loadLocalPatterns()
  if (remoteUrl) {
    const remote = await fetchRemotePatterns(remoteUrl)
    return mergePatterns(local, remote)
  }
  return local
}

function categorizeErrorLines(errorLines: string[], patterns: ErrorPattern[]): Record<string, string[]> {
  const byCategory: Record<string, string[]> = {}
  for (const line of errorLines) {
    let assigned = false
    for (const p of patterns) {
      try {
        const regex = new RegExp(p.pattern, p.flags)
        if (regex.test(line)) {
          const cat = p.category
          if (!byCategory[cat]) byCategory[cat] = []
          byCategory[cat].push(line)
          assigned = true
          break
        }
      } catch {
        /* skip invalid regex */
      }
    }
    if (!assigned) {
      const cat = 'Other'
      if (!byCategory[cat]) byCategory[cat] = []
      byCategory[cat].push(line)
    }
  }
  return byCategory
}

function categorizeWarningLines(warningLines: string[], patterns: ErrorPattern[]): Record<string, string[]> {
  const byCategory: Record<string, string[]> = {}
  for (const line of warningLines) {
    let assigned = false
    for (const p of patterns) {
      try {
        const regex = new RegExp(p.pattern, p.flags)
        if (regex.test(line)) {
          const cat = p.category
          if (!byCategory[cat]) byCategory[cat] = []
          byCategory[cat].push(line)
          assigned = true
          break
        }
      } catch {
        /* skip invalid regex */
      }
    }
    if (!assigned) {
      const cat = 'General'
      if (!byCategory[cat]) byCategory[cat] = []
      byCategory[cat].push(line)
    }
  }
  return byCategory
}

export function extractBuildParams(lines: string[]): BuildParam[] {
  const params: BuildParam[] = []
  const seen = new Set<string>()

  const matchers: { regex: RegExp; source: string; keyIdx: number; valIdx: number }[] = [
    // env var assignments: KEY=value, export KEY=value
    { regex: /^(?:export\s+)?([A-Z][A-Z0-9_]{2,})=(.+)$/,           source: 'env',      keyIdx: 1, valIdx: 2 },
    // GitHub Actions inputs: Input 'name' has been set to 'value'
    { regex: /Input '([^']+)' has been set to '([^']*)'$/,           source: 'input',    keyIdx: 1, valIdx: 2 },
    // Docker --build-arg
    { regex: /--build-arg\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)/,        source: 'cli-flag', keyIdx: 1, valIdx: 2 },
    // Maven / Gradle -D property
    { regex: /-D([A-Za-z_][A-Za-z0-9_.]+)=(\S+)/,                   source: 'cli-flag', keyIdx: 1, valIdx: 2 },
    // Node / npm config: npm_config_KEY=value or NODE_ENV=value
    { regex: /^(npm_config_[A-Za-z_]+|NODE_ENV|NODE_OPTIONS)=(.+)$/, source: 'env',      keyIdx: 1, valIdx: 2 },
    // GitHub env: ::set-env name=KEY::value  (deprecated but still seen)
    { regex: /::set-env name=([^:]+)::(.*)$/,                        source: 'env',      keyIdx: 1, valIdx: 2 },
    // GHA set-output: ::set-output name=KEY::value (legacy)
    { regex: /::set-output name=([^:]+)::(.*)$/,                     source: 'output',   keyIdx: 1, valIdx: 2 },
    // with: key: value (GHA step inputs logged as "  with: key: val")
    { regex: /^\s+with:\s+([A-Za-z_-]+):\s+(.+)$/,                  source: 'input',    keyIdx: 1, valIdx: 2 },
    // env: KEY: value (GHA step env logged as "  env: KEY: val")
    { regex: /^\s+env:\s+([A-Z][A-Z0-9_]+):\s+(.+)$/,               source: 'env',      keyIdx: 1, valIdx: 2 },
  ]

  for (const raw of lines) {
    const line = cleanLine(raw)
    if (!line) continue
    for (const { regex, source, keyIdx, valIdx } of matchers) {
      const m = line.match(regex)
      if (m) {
        const key = m[keyIdx]
        const value = m[valIdx]
        const uid = `${key}=${value}`
        if (!seen.has(uid) && !looksLikeSecret(key, value)) {
          seen.add(uid)
          params.push({ key, value, source })
        }
        break
      }
    }
  }
  return params.slice(0, 30)
}

function looksLikeSecret(key: string, value: string): boolean {
  const secretKeywords = /token|secret|password|passwd|api_key|apikey|auth|credential|private/i
  if (secretKeywords.test(key)) return true
  if (value === '***' || value.includes('***')) return true
  return false
}

export function extractGitRefsFromLogs(lines: string[]): GitRef[] {
  const refs: GitRef[] = []
  const seen = new Set<string>()

  for (const raw of lines) {
    const line = cleanLine(raw)
    if (!line) continue

    // GHA "uses" references: "Download action repository 'actions/checkout@v4'"
    const usesDownload = line.match(/Download action repository '([^']+@[^']+)'/)
    if (usesDownload) {
      const [repo, ref] = usesDownload[1].split('@')
      const uid = `action:${repo}@${ref}`
      if (!seen.has(uid)) { seen.add(uid); refs.push({ repo, ref, type: 'action' }) }
    }

    // Docker image pulls: "Pulling from library/node" or "docker pull org/image:tag"
    const dockerPull = line.match(/(?:docker\s+pull|Pulling\s+from)\s+([a-z0-9_./-]+(?::[a-z0-9_.-]+)?)/i)
    if (dockerPull) {
      const full = dockerPull[1]
      const [repo, ref] = full.includes(':') ? full.split(':') : [full, 'latest']
      const uid = `docker:${repo}:${ref}`
      if (!seen.has(uid)) { seen.add(uid); refs.push({ repo, ref, type: 'docker' }) }
    }

    // Docker image used in FROM: "FROM node:20-alpine AS builder"
    const dockerFrom = line.match(/^FROM\s+([a-z0-9_./-]+(?::[a-z0-9_.-]+)?)/i)
    if (dockerFrom) {
      const full = dockerFrom[1]
      const [repo, ref] = full.includes(':') ? full.split(':') : [full, 'latest']
      const uid = `docker:${repo}:${ref}`
      if (!seen.has(uid)) { seen.add(uid); refs.push({ repo, ref, type: 'docker' }) }
    }

    // Git clone / checkout: "Cloning into 'repo'..." or "git checkout branch"
    const gitClone = line.match(/Cloning into '([^']+)'/i)
    if (gitClone) {
      const repo = gitClone[1]
      const uid = `git:${repo}`
      if (!seen.has(uid)) { seen.add(uid); refs.push({ repo, ref: 'HEAD', type: 'git-checkout' }) }
    }

    // "Checking out ref: refs/heads/branch" or "refs/tags/v1.0"
    const refCheckout = line.match(/(?:Checking out|checkout)\s+(?:ref:\s+)?refs\/(heads|tags)\/(\S+)/i)
    if (refCheckout) {
      const refType = refCheckout[1]
      const refName = refCheckout[2]
      const uid = `ref:${refType}/${refName}`
      if (!seen.has(uid)) { seen.add(uid); refs.push({ repo: '', ref: `${refType}/${refName}`, type: 'git-checkout' }) }
    }

    // Submodule init: "Submodule 'path' registered for path 'path'" or "Submodule 'lib/foo' (https://github.com/org/repo)"
    const submodule = line.match(/[Ss]ubmodule\s+'([^']+)'\s+\(([^)]+)\)/)
    if (submodule) {
      const repo = submodule[2].replace(/\.git$/, '').replace(/^https?:\/\/github\.com\//, '')
      const uid = `submodule:${repo}`
      if (!seen.has(uid)) { seen.add(uid); refs.push({ repo, ref: submodule[1], type: 'submodule' }) }
    }
  }

  return refs.slice(0, 40)
}

export function extractClonedRepos(lines: string[]): ClonedRepo[] {
  const repos: ClonedRepo[] = []
  const seen = new Set<string>()

  let currentRepo = ''
  let currentBranch = ''
  let currentCommit = ''
  let currentDepth = ''

  for (const raw of lines) {
    const line = cleanLine(raw)
    if (!line) continue

    // "Syncing repository: owner/repo"
    const syncMatch = line.match(/Syncing repository:\s+(\S+)/)
    if (syncMatch) {
      if (currentRepo && !seen.has(currentRepo)) {
        seen.add(currentRepo)
        repos.push({ repository: currentRepo, branch: currentBranch || '—', commit: currentCommit || '—', depth: currentDepth || 'full' })
      }
      currentRepo = syncMatch[1]
      currentBranch = ''
      currentCommit = ''
      currentDepth = ''
    }

    // "Setting up auth for https://github.com/owner/repo"
    const authMatch = line.match(/Setting up auth.*github\.com\/([^\s'"]+)/)
    if (authMatch && !currentRepo) {
      currentRepo = authMatch[1].replace(/\.git$/, '')
    }

    // "Checking out ref: refs/heads/main" or "refs/tags/v1.0" or "refs/pull/123/merge"
    const refMatch = line.match(/[Cc]hecking out (?:ref:\s*)?refs\/(heads|tags|pull)\/(\S+)/)
    if (refMatch) {
      const refType = refMatch[1]
      const refName = refMatch[2]
      if (refType === 'heads') currentBranch = refName
      else if (refType === 'tags') currentBranch = `tag: ${refName}`
      else if (refType === 'pull') currentBranch = `PR #${refName.replace('/merge', '')}`
    }

    // "HEAD is now at abc1234 Commit message"
    const headMatch = line.match(/HEAD is now at\s+([a-f0-9]{7,40})/)
    if (headMatch) {
      currentCommit = headMatch[1]
    }

    // "Fetching the repository" with --depth
    const depthMatch = line.match(/--depth[= ](\d+)/)
    if (depthMatch) {
      currentDepth = depthMatch[1]
    }

    // "fetch-depth: N" from logged step inputs
    const fetchDepthInput = line.match(/fetch-depth:\s*(\d+)/)
    if (fetchDepthInput) {
      currentDepth = fetchDepthInput[1] === '0' ? 'full' : fetchDepthInput[1]
    }

    // "git clone https://github.com/owner/repo ..."
    const cloneMatch = line.match(/git\s+clone\s+(?:--[^\s]+\s+)*(?:https?:\/\/github\.com\/)?([^\s'"]+)/i)
    if (cloneMatch && !syncMatch) {
      const clonedRepo = cloneMatch[1].replace(/\.git$/, '')
      if (clonedRepo.includes('/') && !seen.has(clonedRepo)) {
        seen.add(clonedRepo)
        repos.push({ repository: clonedRepo, branch: '—', commit: '—', depth: 'full' })
      }
    }

    // "git fetch origin branch-name"
    const fetchBranch = line.match(/git\s+fetch\s+\S+\s+(\S+)/i)
    if (fetchBranch && currentRepo) {
      const fetched = fetchBranch[1].replace(/^refs\/heads\//, '')
      if (!currentBranch && !fetched.startsWith('-')) currentBranch = fetched
    }
  }

  if (currentRepo && !seen.has(currentRepo)) {
    seen.add(currentRepo)
    repos.push({ repository: currentRepo, branch: currentBranch || '—', commit: currentCommit || '—', depth: currentDepth || 'full' })
  }

  return repos.slice(0, 20)
}

export function extractGitRefsFromSteps(
  steps: { name: string; conclusion: string | null }[],
  jobLogs: string
): GitRef[] {
  const refs: GitRef[] = []
  const seen = new Set<string>()

  // Parse "uses:" lines from logs: "##[group]Run actions/checkout@v4"
  const lines = jobLogs.split('\n')
  for (const raw of lines) {
    const cleaned = cleanLine(raw)
    const runAction = cleaned.match(/^Run\s+([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)@(\S+)/)
    if (runAction) {
      const repo = runAction[1]
      const ref = runAction[2]
      const uid = `${repo}@${ref}`
      if (!seen.has(uid)) { seen.add(uid); refs.push({ repo, ref, type: 'action' }) }
    }
  }

  return refs
}

function extractFailedStep(lines: string[]): string | null {
  for (const line of lines) {
    const clean = cleanLine(line)
    const match = clean.match(/##\[error\].*step[:\s]+(.+)|Run (.+) failed/i)
    if (match) return match[1] || match[2]
  }
  return null
}

export async function analyzeLogs(
  logs: string,
  patterns: ErrorPattern[],
  stepName?: string
): Promise<FailureAnalysis> {
  const rawLines = logs.split('\n')
  const totalLines = rawLines.length
  const errorLines: string[] = []
  const warningLines: string[] = []

  const cleanedLines: { cleaned: string; lineNumber: number }[] = rawLines.map((raw, i) => ({
    cleaned: cleanLine(raw),
    lineNumber: i + 1
  }))

  for (const { cleaned } of cleanedLines) {
    if (cleaned.length === 0) continue
    if (/error|failed|fatal|exception|FAIL|ERR!/i.test(cleaned)) {
      errorLines.push(cleaned)
    } else if (/\bwarn(ing)?\b|WARN|⚠/i.test(cleaned) && !/^\s*\d+\s+warn(ing)?s?\s*$/i.test(cleaned)) {
      warningLines.push(cleaned)
    }
  }

  const buildParams = extractBuildParams(rawLines)

  core.info(`Scanned ${totalLines} log lines, found ${errorLines.length} error lines, ${warningLines.length} warning lines, ${buildParams.length} build params`)

  const warningLinesByCategory = categorizeWarningLines(warningLines, patterns)

  for (const p of patterns) {
    const regex = new RegExp(p.pattern, p.flags)
    for (const { cleaned, lineNumber } of cleanedLines) {
      if (cleaned.length === 0) continue
      if (regex.test(cleaned)) {
        core.info(`Matched pattern: ${p.id} (${p.category}) at line ${lineNumber}`)
        const idx = cleanedLines.findIndex(c => c.lineNumber === lineNumber)
        const contextBefore = idx >= 0 ? cleanedLines.slice(Math.max(0, idx - 2), idx).map(c => c.cleaned).filter(Boolean) : []
        const contextAfter = idx >= 0 ? cleanedLines.slice(idx + 1, Math.min(cleanedLines.length, idx + 3)).map(c => c.cleaned).filter(Boolean) : []
        const errorLinesByCategory = categorizeErrorLines(errorLines, patterns)
        return {
          rootCause: p.rootCause,
          failedStep: stepName || extractFailedStep(rawLines) || 'Unknown step',
          suggestion: p.suggestion,
          errorLines,
          errorLinesByCategory,
          warningLines,
          warningLinesByCategory,
          exactMatchLine: cleaned,
          exactMatchLineNumber: lineNumber,
          contextBefore,
          contextAfter,
          totalLines,
          severity: p.severity,
          matchedPattern: p.id,
          category: p.category,
          docsUrl: p.docsUrl,
          buildParams
        }
      }
    }
  }

  const errorLinesByCategory = categorizeErrorLines(errorLines, patterns)
  return {
    rootCause: 'Unknown failure — could not automatically detect root cause',
    failedStep: stepName || extractFailedStep(rawLines) || 'Unknown step',
    suggestion: 'Review the error lines below. Consider adding a custom pattern to patterns.json to handle this error in future runs.',
    errorLines,
    errorLinesByCategory,
    warningLines,
    warningLinesByCategory,
    exactMatchLine: errorLines[0] || '',
    exactMatchLineNumber: 0,
    contextBefore: [],
    contextAfter: errorLines.slice(1, 3),
    totalLines,
    severity: 'warning',
    matchedPattern: 'none',
    category: 'Unknown',
    buildParams
  }
}
