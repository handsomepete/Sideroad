# Server brief: four stages

You are running on my server. Four stages, in order. Diagnose before
changing anything. After EACH stage, stop, report what you found, what
you changed and the test output, and wait for me to say "go" before
starting the next one.

Hard rules for every stage:
- Never print, echo, cat or log secret values (API keys, tokens, .env
  contents). Refer to them by variable name only.
- Do not modify homeos-mcp, context-gateway or the brief pipeline beyond
  what a stage explicitly asks for.
- If anything is ambiguous or looks different from what I describe,
  stop and ask rather than guessing.

## STAGE 1: Rotate the context-gateway key

CONTEXT_GATEWAY_API_KEY sits in plaintext in
/root/mcp_gateway/ecosystem.config.cjs, mode 644, and was disclosed, so
treat it as compromised.

1. Generate a new key value without displaying it.
2. Move the secret out of ecosystem.config.cjs into an env file
   (e.g. /root/mcp_gateway/.env), mode 600, and have the PM2 config
   load it from there.
3. chmod 600 ecosystem.config.cjs as well.
4. pm2 restart context-gateway and confirm it's healthy on its port.
5. Confirm the old key is rejected and the new one works, without
   printing either.
6. Tell me which clients need the new key so I can update them myself
   (the claude.ai connector for mcp.noxsecurity.io at minimum). Write the
   new key to a file only I can read and tell me the path.

## STAGE 2: Fix job alert ingestion

LinkedIn job alerts get Label_6837363001237232662 from a Gmail filter
and skip the inbox. The morning brief pipeline in /var/www/cowork/
searches the inbox, so it gets zero alerts.

1. Show me the current Gmail query before editing.
2. Change it to label-scoped:
   label:Label_6837363001237232662 from:jobalerts-noreply@linkedin.com
   No in:inbox anywhere in this path.
3. Audit every other Gmail query in the pipeline for the same inbox
   assumption. Report findings; don't change anything outside job
   alerts without asking.
4. Make empty different from broken: if zero alert emails are retrieved
   for the window, render "No alert emails retrieved" instead of "(0)".
5. Parse EVERY job listed in each alert email, including the "New jobs
   from your other alerts" sections, not just the headline job.
6. One-off backfill of the last 14 days, deduplicated against existing
   Airtable records.
7. Test:
   cd /var/www/cowork && PYTHONPATH=/var/www venv/bin/python -m cowork.main --morning

## STAGE 3: Install Hermes Agent, isolated

Goal: a pilot alongside HomeOS, not a replacement. Hermes Agent is Nous
Research's self-hosted personal agent.

1. Find the official Hermes Agent install docs and tell me the exact
   install method and what it needs BEFORE installing anything. Don't
   install from unofficial forks or scripts.
2. Create a dedicated non-root user (e.g. hermes). Hermes must not be
   able to read /opt/homeos-mcp, /root/mcp_gateway, /var/www or any of
   their env files. Verify that with a read test as that user.
3. Bind anything Hermes listens on to 127.0.0.1 only. If the install
   uses Docker, do NOT publish ports publicly: Docker writes its own
   iptables rules and bypasses ufw.
4. Give it its own LLM API key with a hard monthly spend cap, not the
   shared LiteLLM proxy, so the pilot stays walled off.
5. Messaging: use Telegram for the pilot (not WhatsApp; the Baileys
   session persistence problem is unsolved). Restrict it to respond
   only to my Telegram user ID.
6. Show me the full config (secrets redacted) and confirm it runs
   under PM2 or systemd as the hermes user.

## STAGE 4: First proactive job: daily job alert triage

Hermes gets read-only Gmail access scoped as narrowly as possible (the
job alert label only, if the method allows). No send, no delete, no
write to Airtable or Linear in this pilot.

Each weekday morning, read the last 24h of alerts, check every listed
job, and send me ONE Telegram message: either "Nothing worth applying
to" or the few that are, one line each on why. No per-job list of skips.

Skip criteria: banks (including subsidiaries like Tangerine), consulting
firms, deep coding roles, French-language roles, US relocation, Markham,
fully on-site, Mozilla, GitLab, Homebase. Hybrid only if 2 days a week
or fewer in office. Target level Staff, Principal, Director. Flag any
company I've already applied to (check the Airtable pipeline read-only)
instead of recommending it again.

Run it once manually against today's alerts and show me the message
before scheduling it.
