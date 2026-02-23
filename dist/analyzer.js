"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPatterns = loadPatterns;
exports.analyzeLogs = analyzeLogs;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const core = __importStar(require("@actions/core"));
// Strip GitHub Actions log timestamps and ANSI color codes
function cleanLine(raw) {
    return raw
        .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '') // remove timestamp: 2026-02-22T19:12:50.8020453Z
        .replace(/\x1b\[[0-9;]*[mGKHF]/g, '') // remove ANSI color codes: \u001b[36;1m
        .replace(/##\[(?:error|warning|debug|group|endgroup)\]/g, '') // remove GHA annotations
        .trim();
}
function loadLocalPatterns() {
    const localPath = path.join(__dirname, '..', 'patterns.json');
    try {
        if (fs.existsSync(localPath)) {
            const raw = fs.readFileSync(localPath, 'utf-8');
            const parsed = JSON.parse(raw);
            core.info(`Loaded ${parsed.patterns.length} patterns from patterns.json (v${parsed.version})`);
            return parsed.patterns;
        }
    }
    catch (err) {
        core.warning(`Could not load local patterns.json: ${err}`);
    }
    return [];
}
async function fetchRemotePatterns(remoteUrl) {
    try {
        core.info(`Fetching remote patterns from ${remoteUrl}...`);
        const response = await fetch(remoteUrl, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) {
            core.warning(`Remote patterns fetch failed: HTTP ${response.status}`);
            return [];
        }
        const parsed = await response.json();
        core.info(`Loaded ${parsed.patterns.length} remote patterns (v${parsed.version})`);
        return parsed.patterns;
    }
    catch (err) {
        core.warning(`Could not fetch remote patterns: ${err}`);
        return [];
    }
}
function mergePatterns(local, remote) {
    const localIds = new Set(local.map(p => p.id));
    const remoteOnly = remote.filter(p => !localIds.has(p.id));
    const merged = [...local, ...remoteOnly];
    core.info(`Using ${merged.length} total patterns (${local.length} local + ${remoteOnly.length} remote)`);
    return merged;
}
async function loadPatterns(remoteUrl) {
    const local = loadLocalPatterns();
    if (remoteUrl) {
        const remote = await fetchRemotePatterns(remoteUrl);
        return mergePatterns(local, remote);
    }
    return local;
}
function categorizeErrorLines(errorLines, patterns) {
    const byCategory = {};
    for (const line of errorLines) {
        let assigned = false;
        for (const p of patterns) {
            try {
                const regex = new RegExp(p.pattern, p.flags);
                if (regex.test(line)) {
                    const cat = p.category;
                    if (!byCategory[cat])
                        byCategory[cat] = [];
                    byCategory[cat].push(line);
                    assigned = true;
                    break;
                }
            }
            catch {
                /* skip invalid regex */
            }
        }
        if (!assigned) {
            const cat = 'Other';
            if (!byCategory[cat])
                byCategory[cat] = [];
            byCategory[cat].push(line);
        }
    }
    return byCategory;
}
function extractFailedStep(lines) {
    for (const line of lines) {
        const clean = cleanLine(line);
        const match = clean.match(/##\[error\].*step[:\s]+(.+)|Run (.+) failed/i);
        if (match)
            return match[1] || match[2];
    }
    return null;
}
async function analyzeLogs(logs, patterns, stepName) {
    const rawLines = logs.split('\n');
    const totalLines = rawLines.length;
    const errorLines = [];
    // Clean and collect error lines with their original line numbers
    const cleanedLines = rawLines.map((raw, i) => ({
        cleaned: cleanLine(raw),
        lineNumber: i + 1
    }));
    // Collect lines that look like errors (after cleaning)
    for (const { cleaned } of cleanedLines) {
        if (/error|failed|fatal|exception|FAIL|ERR!/i.test(cleaned) && cleaned.length > 0) {
            errorLines.push(cleaned);
        }
    }
    core.info(`Scanned ${totalLines} log lines, found ${errorLines.length} error lines`);
    // Tier 1 — pattern matching on cleaned lines
    for (const p of patterns) {
        const regex = new RegExp(p.pattern, p.flags);
        for (const { cleaned, lineNumber } of cleanedLines) {
            if (cleaned.length === 0)
                continue;
            if (regex.test(cleaned)) {
                core.info(`Matched pattern: ${p.id} (${p.category}) at line ${lineNumber}`);
                const idx = cleanedLines.findIndex(c => c.lineNumber === lineNumber);
                const contextBefore = idx >= 0 ? cleanedLines.slice(Math.max(0, idx - 2), idx).map(c => c.cleaned).filter(Boolean) : [];
                const contextAfter = idx >= 0 ? cleanedLines.slice(idx + 1, Math.min(cleanedLines.length, idx + 3)).map(c => c.cleaned).filter(Boolean) : [];
                const errorLinesByCategory = categorizeErrorLines(errorLines, patterns);
                return {
                    rootCause: p.rootCause,
                    failedStep: stepName || extractFailedStep(rawLines) || 'Unknown step',
                    suggestion: p.suggestion,
                    errorLines,
                    errorLinesByCategory,
                    exactMatchLine: cleaned,
                    exactMatchLineNumber: lineNumber,
                    contextBefore,
                    contextAfter,
                    totalLines,
                    severity: p.severity,
                    matchedPattern: p.id,
                    category: p.category,
                    docsUrl: p.docsUrl
                };
            }
        }
    }
    // No pattern matched — generic fallback
    const errorLinesByCategory = categorizeErrorLines(errorLines, patterns);
    return {
        rootCause: 'Unknown failure — could not automatically detect root cause',
        failedStep: stepName || extractFailedStep(rawLines) || 'Unknown step',
        suggestion: 'Review the error lines below. Consider adding a custom pattern to patterns.json to handle this error in future runs.',
        errorLines,
        errorLinesByCategory,
        exactMatchLine: errorLines[0] || '',
        exactMatchLineNumber: 0,
        contextBefore: [],
        contextAfter: errorLines.slice(1, 3),
        totalLines,
        severity: 'warning',
        matchedPattern: 'none',
        category: 'Unknown'
    };
}
