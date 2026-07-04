# Scribe (Claude on Oracle) - Finish Tomorrow

Tonight's scaffold is committed. Below is the exact list of things to do to bring the Scribe live tomorrow.

## What's already in place

- `src/scribe.ts` - Scribe worker (queue, git, malware scan, ClamAV, audit, timeout)
- `src/scribe-security.ts` - Diff scanner, prompt sanitizer, branch validator, timing-safe secret compare
- `src/index.ts` - `POST /scribe` and `GET /scribe/status` endpoints wired
- FK: `server/alfred-scribe-client.ts` dispatches to Oracle
- FK: `server/alfred-tools.ts` verb `scribe_code_change` (Tyler-only enforced at validate + execute time)
- FK: `server/alfred-routes.ts` system prompt teaches Alfred the verb

Scribe is DISABLED by default (`SCRIBE_ENABLED=false`) so a stray dispatch does nothing until we flip it.

## Finish-up on Oracle (do these tomorrow)

### 1. Install Claude Code CLI in the container

The Docker image needs `claude` on PATH. Add to `Dockerfile` before the final stage:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code@latest
```

Rebuild and restart the container.

### 2. Set the new env vars on Oracle

Append to `~/alfred-bridge/.env`:

```
SCRIBE_ENABLED=true
ANTHROPIC_API_KEY=sk-ant-...            # required for headless claude
SCRIBE_GIT_TOKEN=ghp_...                # GitHub PAT with 'repo' scope for the fractionkings repo
SCRIBE_DAILY_MAX=10                     # optional, defaults to 10
TYLER_EMAIL=tyler@fractionkings.com     # optional override
```

Restart the container so the env picks up.

### 3. Install ClamAV daemon (malware scanner)

```bash
sudo apt-get update
sudo apt-get install -y clamav clamav-daemon
sudo systemctl enable --now clamav-freshclam
sudo systemctl enable --now clamav-daemon
```

Wait ~2 min for `clamav-freshclam` to download the definitions, then verify:

```bash
clamdscan --version
```

The Scribe worker calls `clamdscan` if it's on PATH; if missing, it fails-open (still runs the static malware-pattern scan).

### 4. Firewall + fail2ban hardening on the VM

Everything currently accepts on 8080 from any source. Lock it down:

```bash
# Allow only Vercel + your home IP on 8080
sudo ufw allow 22/tcp
sudo ufw allow 8080/tcp   # keep open for FK -> bridge until we IP-allowlist
sudo ufw --force enable

# fail2ban to slow SSH bruteforce
sudo apt-get install -y fail2ban
sudo systemctl enable --now fail2ban
```

Optional-later: use Cloudflare in front of the bridge so 8080 is only reachable through Cloudflare's edge, then allowlist only Cloudflare IPs on the VM firewall.

### 5. Grant GitHub write access

The `SCRIBE_GIT_TOKEN` above needs `repo` scope. Generate at https://github.com/settings/tokens (classic PAT, expiry 90d). Store on Oracle only, never commit.

### 6. GitHub main-branch protection

At https://github.com/tjg-bot/fractionkings/settings/branches, protect `main`:

- Require PR before merging
- Require status checks (Vercel preview build)
- Prevent force push
- Do not allow deletions

This means even if the Scribe went rogue it could only ever land on a branch, never overwrite prod.

### 7. Test dry-run

Once `SCRIBE_ENABLED=true` and env is set, from your laptop:

```bash
curl -X POST http://40.233.114.136:8080/scribe \
  -H "Authorization: Bearer $ALFRED_BRIDGE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId":"test-1",
    "prompt":"Add a comment saying // hello from Scribe to server/logger.ts on line 1",
    "requesterEmail":"tyler@fractionkings.com",
    "requesterName":"Tyler"
  }'
```

Then:

```bash
curl "http://40.233.114.136:8080/scribe/status?taskId=test-1" \
  -H "Authorization: Bearer $ALFRED_BRIDGE_SECRET"
```

Expect: a new branch `alfred/YYYYMMDDHHMMSS-add-a-comment-...` on GitHub, Vercel builds it, preview URL appears.

### 8. WhatsApp end-to-end test

Once dry-run passes, in the founding kings group send:

> Alfred, add a comment "// hello from Scribe" to server/logger.ts

Alfred should propose `scribe_code_change`. You confirm. Scribe runs. Alfred reports back with branch name + preview URL.

## Security posture (already baked in)

| Threat | Control |
|---|---|
| Non-Tyler tries to dispatch | Enforced in FK system prompt (HARD RULE) + FK validator + FK executor + Oracle worker |
| Bridge secret stolen | Timing-safe compare; kill-switch env; day-cap |
| Prompt injection | Sanitizer strips control chars + flags known jailbreak sigils |
| Malicious code inserted | Static pattern scan + optional ClamAV daemon |
| Sensitive files touched | Deny-list blocks writes to .env, .github/, vercel.json, .ssh/, .npmrc |
| Force-push to main | Impossible: branch names must match `alfred/*`, git push never uses --force |
| Cost bomb | SCRIBE_DAILY_MAX (10 runs/24h), per-job 10 min timeout |
| Backdoored dependency | Static scan flags `postinstall`, `git+ssh://` dep URLs, weird domains |
| Container escape | Runs in Docker with limited caps; consider AppArmor profile in a later pass |

## Other Alfred improvements shipped tonight

- **Sleep-gate removed.** Bridge no longer sets Alfred to "unavailable at boot (overnight sleep hours)". Alfred is now truly omnipresent per hard rule. Only exception: a 2% micro-AFK toggle during the day that lasts 30-90 sec.
- **Ops group always responds.** Handler routes: kings group keeps mode-based routing (so it doesn't spam), ops group always replies (so Danlyn / Dhei / staff get visible engagement).

## Still on the punch list (not tonight)

- Staff voice differentiation - kings get butler Old English, staff (Danlyn, Dhei) get professional / direct-command tone. Bridge already tags the group; FK system prompt needs a channel-aware branch.
- Voice notes on Oracle - code is on GitHub, image needs rebuild
- Playwright verbs (Alfred controls the browser)
- Jarvis dashboard in `/admin`
- Todo verbs (`alfred_add_todo`, `alfred_list_todos`, `alfred_complete_todo`) + daily reminder cron
- Social intelligence (TikTok, Instagram, Facebook scanning)
