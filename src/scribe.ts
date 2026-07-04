/**
 * Alfred Scribe - Claude Code worker running on Oracle.
 *
 * Purpose: let Tyler text Alfred from anywhere ("Alfred, fix X in cron-Y")
 * and have a headless Claude Code session make the change against the FK
 * repo, push to a branch, and report back. Alfred is the interface;
 * the Scribe is the hand.
 *
 * Flow:
 *   1. FK server posts a task to POST /scribe {taskId, prompt, requester}
 *   2. Scribe validates bridge secret + verifies requester is Tyler
 *   3. Runs in background: git pull main, create branch, invoke
 *      `claude -p "<prompt>"` in the repo, git commit + push
 *   4. Reports status back via the FK callback URL (or Alfred polls)
 *
 * Safety rails baked in:
 *   - Only Tyler's email may trigger a task (checked at FK server AND here)
 *   - Never commits to main; always alfred/<timestamp>-<slug>
 *   - Rate limit: 1 concurrent scribe job (queue rest)
 *   - Timeout: 10 min per job, hard kill after
 *   - Every run journaled to /data/scribe-runs.jsonl for audit
 *
 * Env vars consumed:
 *   ALFRED_BRIDGE_SECRET  - shared with FK for auth (already set)
 *   ANTHROPIC_API_KEY     - required for headless Claude Code (NEW - add tomorrow)
 *   SCRIBE_REPO_URL       - https clone URL for FK repo
 *   SCRIBE_REPO_DIR       - local path on Oracle (default: /data/fractionkings)
 *   SCRIBE_GIT_TOKEN      - github PAT for pushing (NEW - add tomorrow)
 *   SCRIBE_GIT_USER_EMAIL - commit author email (default: alfred@fractionkings.com)
 *   SCRIBE_GIT_USER_NAME  - commit author name (default: Alfred Scribe)
 *   TYLER_EMAIL           - hard-coded to tyler@fractionkings.com; here as env
 *                           for override in case Tyler's email ever changes
 */

import { spawn } from "node:child_process";
import { mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import {
  scanDiff,
  sanitizePrompt,
  assertSafeBranch,
  timingSafeSecretMatch,
  clamScan,
} from "./scribe-security.js";

const log = logger.child ? logger.child({ module: "scribe" }) : logger;

const TYLER_EMAIL = (process.env.TYLER_EMAIL || "tyler@fractionkings.com").toLowerCase();
const REPO_URL = process.env.SCRIBE_REPO_URL || "https://github.com/tjg-bot/fractionkings.git";
const REPO_DIR = process.env.SCRIBE_REPO_DIR || "/data/fractionkings";
const GIT_USER_EMAIL = process.env.SCRIBE_GIT_USER_EMAIL || "alfred@fractionkings.com";
const GIT_USER_NAME = process.env.SCRIBE_GIT_USER_NAME || "Alfred Scribe";
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 min hard cap per subprocess
const AUDIT_LOG = "/data/scribe-runs.jsonl";

// Kill switch. Set SCRIBE_ENABLED=false on Oracle to reject ALL scribe traffic
// while leaving Alfred chat + operational verbs intact. Default is disabled so
// tomorrow's finish-up is an explicit opt-in.
const SCRIBE_ENABLED = String(process.env.SCRIBE_ENABLED || "false").toLowerCase() === "true";

// Daily job cap - prevents runaway token spend + accidental self-DoS.
const DAILY_MAX = Number(process.env.SCRIBE_DAILY_MAX || "10");
const dailyRuns: number[] = []; // timestamps of runs in last 24h

let currentJob: ScribeJob | null = null;

export interface ScribeJob {
  taskId: string;
  prompt: string;
  requesterEmail: string;
  requesterName: string;
  startedAt: string;
  status: "queued" | "running" | "done" | "failed";
  branchName?: string;
  commitSha?: string;
  summary?: string;
  errorMessage?: string;
}

export interface ScribeStartResponse {
  ok: boolean;
  taskId: string;
  status: ScribeJob["status"];
  message: string;
}

/**
 * Kicks off a Scribe run in the background. Returns immediately with an
 * ack; the actual work happens async. Tyler check is enforced BOTH here and
 * upstream in FK - defence in depth.
 */
export async function startScribeJob(input: {
  taskId: string;
  prompt: string;
  requesterEmail: string;
  requesterName: string;
}): Promise<ScribeStartResponse> {
  if (!SCRIBE_ENABLED) {
    return {
      ok: false,
      taskId: input.taskId,
      status: "failed",
      message: "Scribe is disabled on this host. Set SCRIBE_ENABLED=true to enable.",
    };
  }

  const email = (input.requesterEmail || "").toLowerCase().trim();
  if (email !== TYLER_EMAIL) {
    return {
      ok: false,
      taskId: input.taskId,
      status: "failed",
      message: `Scribe refused: only ${TYLER_EMAIL} may command code changes. Sender was ${email || "(unknown)"}.`,
    };
  }

  // Daily cap - prune runs older than 24h then check remaining budget.
  const now = Date.now();
  while (dailyRuns.length > 0 && now - dailyRuns[0] > 24 * 60 * 60 * 1000) {
    dailyRuns.shift();
  }
  if (dailyRuns.length >= DAILY_MAX) {
    return {
      ok: false,
      taskId: input.taskId,
      status: "failed",
      message: `Scribe day-cap reached (${DAILY_MAX} runs in last 24h). Try again later.`,
    };
  }

  if (currentJob && currentJob.status === "running") {
    return {
      ok: false,
      taskId: input.taskId,
      status: "queued",
      message: `Another Scribe job is running (${currentJob.taskId}). This one is queued but not yet implemented - please wait.`,
    };
  }

  // Sanitize the prompt (strip control chars, cap length, flag jailbreaks).
  const sanitized = sanitizePrompt(input.prompt);
  if (sanitized.flagged.length > 0) {
    log.warn({ taskId: input.taskId, flagged: sanitized.flagged }, "Prompt sanitizer flagged input");
  }

  const job: ScribeJob = {
    taskId: input.taskId,
    prompt: sanitized.text,
    requesterEmail: email,
    requesterName: input.requesterName || "Tyler",
    startedAt: new Date().toISOString(),
    status: "running",
  };
  currentJob = job;
  dailyRuns.push(now);

  // Fire-and-forget - the runner logs its own outcome. Consumers query
  // /scribe/status to poll.
  runScribeJob(job).catch((err) => {
    log.error({ err, taskId: job.taskId }, "Scribe job crashed uncaught");
    job.status = "failed";
    job.errorMessage = err instanceof Error ? err.message : String(err);
  });

  return {
    ok: true,
    taskId: job.taskId,
    status: "running",
    message: "Scribe hath taken up thy quill. Await word.",
  };
}

export function getScribeStatus(taskId: string): ScribeJob | null {
  if (currentJob && currentJob.taskId === taskId) return currentJob;
  return null;
}

async function runScribeJob(job: ScribeJob): Promise<void> {
  const started = Date.now();
  try {
    await ensureRepo();
    const branchName = mkBranchName(job.prompt);
    assertSafeBranch(branchName); // hard-refuses if not alfred/*
    job.branchName = branchName;

    await runGit(["fetch", "origin", "main"]);
    await runGit(["checkout", "main"]);
    await runGit(["reset", "--hard", "origin/main"]);
    // Clean untracked files from previous runs so scan is deterministic.
    await runGit(["clean", "-fd"]);
    await runGit(["checkout", "-b", branchName]);

    // Headless Claude Code invocation. Requires `claude` CLI on PATH.
    // Tomorrow-morning tasks:
    //   1. Install Claude Code CLI in the container (npm i -g @anthropic-ai/claude-code)
    //   2. Set ANTHROPIC_API_KEY on the Oracle VM env-file
    //   3. Verify `claude --version` returns from within the container
    const claudeOut = await runClaudeCode(job.prompt);
    job.summary = claudeOut.slice(0, 4_000);

    // Detect whether Claude actually made changes.
    const status = await runGit(["status", "--porcelain"]);
    if (!status.trim()) {
      job.status = "done";
      job.summary = (job.summary || "") + "\n\n[Scribe: no file changes were made. Task returned prose only.]";
      await audit(job, Date.now() - started);
      return;
    }

    // ─── SECURITY GATE: static scan of the diff BEFORE push ───────────────
    // Blocks: writes to .github/, vercel.json, .env*, .ssh/, .npmrc, etc.
    // Blocks: reverse-shell patterns, eval(atob()), curl|sh, postinstall
    //         hooks, coinminer domains, git+ssh dep URLs, chmod 777, rm -rf /
    await runGit(["add", "-A"]);
    const diffPatch = await runGit(["diff", "--staged"]);
    const namesOut = await runGit(["diff", "--staged", "--name-only"]);
    const changedFiles = namesOut.split("\n").map((s) => s.trim()).filter(Boolean);
    const scan = scanDiff(diffPatch, changedFiles);
    if (!scan.ok) {
      // Reset the staged changes; do NOT push. Report offenders to Alfred.
      await runGit(["reset", "--hard", "origin/main"]);
      job.status = "failed";
      const parts: string[] = [];
      if (scan.deniedPaths.length > 0) {
        parts.push(`Denied paths touched: ${scan.deniedPaths.join(", ")}`);
      }
      if (scan.offenders.length > 0) {
        parts.push(
          "Malware patterns detected: " +
            scan.offenders.map((o) => `${o.file} [${o.hits.join(", ")}]`).join(" | "),
        );
      }
      job.errorMessage = "Security gate blocked push. " + parts.join(" ");
      log.error({ taskId: job.taskId, scan }, "Scribe security gate blocked push");
      await audit(job, Date.now() - started);
      return;
    }

    // Optional ClamAV pass over the repo (fail-open if clamdscan missing).
    const infected = await clamScan(REPO_DIR, 60_000);
    if (infected.length > 0) {
      await runGit(["reset", "--hard", "origin/main"]);
      job.status = "failed";
      job.errorMessage = `ClamAV flagged ${infected.length} file(s): ${infected.slice(0, 3).join("; ")}`;
      log.error({ taskId: job.taskId, infected }, "Scribe blocked by ClamAV");
      await audit(job, Date.now() - started);
      return;
    }

    // All gates passed - commit + push.
    await runGit([
      "commit",
      "-m",
      `alfred-scribe: ${firstLine(job.prompt)}\n\nRequested by ${job.requesterName} via WhatsApp.\nTask: ${job.prompt.slice(0, 500)}`,
    ]);
    const sha = (await runGit(["rev-parse", "HEAD"])).trim();
    job.commitSha = sha;
    // NOTE: never --force here. If push is rejected, that's a real conflict
    // and Tyler sees the error via the audit log + Alfred callback.
    await runGit(["push", "-u", "origin", branchName]);

    job.status = "done";
    await audit(job, Date.now() - started);
  } catch (err) {
    job.status = "failed";
    job.errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err, taskId: job.taskId }, "Scribe run failed");
    await audit(job, Date.now() - started);
  }
}

async function ensureRepo(): Promise<void> {
  if (existsSync(path.join(REPO_DIR, ".git"))) return;
  await mkdir(path.dirname(REPO_DIR), { recursive: true });
  const url = withTokenIfSet(REPO_URL);
  await runShell("git", ["clone", url, REPO_DIR], "/data");
  await runGit(["config", "user.email", GIT_USER_EMAIL]);
  await runGit(["config", "user.name", GIT_USER_NAME]);
}

function withTokenIfSet(url: string): string {
  const token = process.env.SCRIBE_GIT_TOKEN;
  if (!token || !url.startsWith("https://")) return url;
  return url.replace("https://", `https://x-access-token:${token}@`);
}

function runGit(args: string[]): Promise<string> {
  return runShell("git", args, REPO_DIR);
}

function runShell(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${JOB_TIMEOUT_MS}ms`));
    }, JOB_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function runClaudeCode(prompt: string): Promise<string> {
  // Headless mode - claude reads prompt via stdin, prints response to stdout.
  // `--print` runs non-interactively. Requires ANTHROPIC_API_KEY in env.
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["--print", "--dangerously-skip-permissions"], {
      cwd: REPO_DIR,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude timed out after ${JOB_TIMEOUT_MS}ms`));
    }, JOB_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited ${code}: ${stderr || stdout}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function mkBranchName(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "") || "task";
  const ts = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `alfred/${ts}-${slug}`;
}

function firstLine(s: string): string {
  const line = (s.split("\n")[0] || s).trim();
  return line.slice(0, 72);
}

async function audit(job: ScribeJob, durationMs: number): Promise<void> {
  try {
    const line = JSON.stringify({ ...job, durationMs, auditedAt: new Date().toISOString() }) + "\n";
    await appendFile(AUDIT_LOG, line, "utf8");
  } catch (err) {
    log.warn({ err }, "Failed to write scribe audit line");
  }
}
