# Tool activity

Open a tool-group summary in the conversation to see its individual calls. Each row has an icon;
select a row to inspect its details. Select the group summary again to collapse it.

Long groups scroll inside a bounded area without expanding the whole conversation. Faded edges
indicate more calls above or below. Short groups use only the space they need.
Collapsing and reopening a group preserves your reading position and any open call details.

Recognized Pylon tools use descriptive labels in both the running summary and individual rows.
Labels follow the call's state, such as "Clicking" while running and "Clicked" after success.
Failed, declined, and stopped calls say what happened without implying success.
Preview browser actions use a globe icon. Other Pylon tools keep the Pylon mark.
Group summaries count browser actions separately, such as "Used browser 18 times" or
"Ran 4 commands and used browser 15 times". Browser-only groups also use a globe icon.

Command summaries show the program inside a shell wrapper, such as "Running vp" for
`/bin/zsh -lc 'vp test run'`. Expanded rows keep the full command.

While a turn is active, Thinking appears when no tool call or subagent card owns the live activity row. Completed calls keep their outcome labels. A subagent card groups the agents launched in that turn; expand it to see each agent's latest reported status and details, and collapse it to return to the summary. Identically named agents remain separate.

A single finished tool call shows its command or action instead of a one-call count. Failed tool rows open to show their full error, even when the error arrived only as a short row label. Repeated labels are omitted from expanded details. Command output is retained even when it matches the command.

Long run durations include hours, such as "Worked for 6h 59m 50s". Live timers use the same hour format.
