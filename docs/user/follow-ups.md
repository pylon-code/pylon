# Follow-ups

Follow-ups are a per-project list of things to come back to: work you noticed but are not doing
now, and ideas you do not want to lose. Turn them on in **Settings → Beta**. Restart the
environment once after enabling follow-ups so agents can discover their follow-up tools.

Open **Follow-ups** from the sidebar. Items are grouped into blockers, open items, and ideas.
The list only shows projects in connected environments where the beta is enabled.

## Filing

Add an item yourself, or ask an agent to file one in conversation — "add a follow-up to check the
retry logic". Agents also file follow-ups on their own when they consciously set work aside,
recording what they saw and why they did not do it.

Agents may not file a follow-up for work you asked them to do. If it was in scope, they finish it.

## Taking on and validating work

Use **Start thread** to open a normal project thread seeded with the full dossier: the observation,
verify check, evidence, source context, and any branch gate. The dossier is added without replacing
text already waiting in the draft.

Use **Validate** when you first need to check whether an open item still applies. Validation runs
in a visible project thread and records one of three outcomes:

- **Still needed** and **Uncertain** leave the item open.
- **Moot** closes it, and requires concrete evidence from the check.

Validation never waives an item. If a check is inconclusive, the item stays open and continues to
block its branch when it is a blocker.

## Blockers

A blocker names the branch it gates. Pylon refuses to open a change request for a branch that
still has unresolved blockers in that project, so work cannot quietly ship past something that
needed attention. The branch toolbar shows the unresolved blocker count.

Resolve a blocker once it is handled, or waive it if you decide it does not need doing. Only you
can waive — an agent cannot dismiss its own blocker.

Closed items keep their resolution note and links to the resolution or validation thread and
commit. Use **Reopen** if the work becomes relevant again.

## Ideas

Ideas are allowed to never happen. Capture them without committing to them; resolve or waive them
when you make a decision, and reopen them if that decision changes.
