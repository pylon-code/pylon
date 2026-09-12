# Claude

Pylon uses Claude Code's login and configuration. Start with the default provider for one account;
[provider setup](./install.md#providers) covers installation and shared provider settings.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
Pylon uses the Claude configuration on the connected server.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named presets that
need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine, create the second
login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings → Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The custom setting changes
`CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain location intact. Use the same variable
for the login command. Setting `HOME` instead can put credentials where this provider will not find
them.

You can also sign an account in without a terminal. Add a Claude provider with its own
**CLAUDE_CONFIG_DIR path**, then choose **Sign in** on its card and pick how the account signs in:
Claude subscription, Anthropic Console, or single sign-on. These are not interchangeable. Complete
the Claude sign-in page and paste the code back into Pylon. Watch the email on the login page: signing
in twice as the same account leaves two providers sharing one subscription's limits.

Check the email reported in provider settings after signing in; click the blurred email to reveal
it. Existing threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation state. Claude does not
have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's **Environment variables**.
Variable assignments do not belong in **Launch arguments**.

## When one account runs out

Pylon uses one account until it runs out rather than spreading work across accounts, because Claude
never shares a prompt cache between organizations and every switch starts fresh. When Claude refuses a
turn because a subscription window is spent, Pylon marks that account out of capacity until the window
resets, and new threads open on the next account with room. Threads that are already running do not
move.

Accounts drain in the order listed in **Settings → Providers**. With more than one account for a
provider, use the up and down arrows on an account to change that order for new threads. A pill at
the bottom of the sidebar names the account that picked up the work and roughly when the spent one
returns. If every account is out of capacity, Pylon still sends to one so you see Claude's own
message.

When the account a thread runs on is out of capacity and another has room, an **Out of capacity** tab
appears above the composer. It shows roughly what continuing elsewhere would cost before anything is
spent. Pylon never switches on its own. Continuing starts a new thread on the other account with the
original request, the conversation so far, and a summary of changed files; long threads carry their
most recent turns. The original thread stays open, and both threads link to each other.

## Usage limits and sign-in errors

If your Claude subscription runs out of usage mid-turn, the thread shows which limit was reached and
the remaining wait when Claude provides a reset time. Claude Code holds the turn until that window
reopens, so it can keep showing as working. Wait for the reset, or stop the turn and continue later.
If Claude ends the turn instead, Pylon names the limit; send the message again after it resets.

When Claude cannot authenticate, the failed turn includes sign-in guidance. Sign in on the machine
running that environment with the same config directory as the provider, using **Sign in** in
**Settings → Providers** or the working directory and `CLAUDE_CONFIG_DIR` values shown in the error.
Start a new thread afterwards; an existing Claude process may still hold the old credentials.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between `100000` and
`1000000`. For example, `300000` asks Claude to summarize at about 300,000 tokens. This changes when
compaction happens, not the model's context window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer compaction from the
context meter and may suggest it when you return to a large older thread. See
[commands and skills](./composer.md#commands-and-skills) for using composer commands.

## Task list

Claude Code hides its task-tracking tools on its newest models. Pylon turns them back on by default,
which fills the **Tasks** badge above the composer and the current-step label while Claude works. To
keep Claude Code's own default and save the context those tools use, turn **Task list** off in the
Claude provider settings. The task list shows on web and desktop.

## Skills

Claude skills come from the config directory's `skills` folder and the project's `.claude/skills`
folder. If both define the same name, the config-directory copy wins. Skills disabled in Claude's
settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation` can still be
started by you. Invoke those one per message: Claude directly runs only the last named skill and may
try to start earlier ones through its Skill tool, which refuses skills reserved for manual invocation.

## OpenRouter

Create a Claude instance with its own config directory, such as `~/.claude_openrouter`, and keep
**Binary path** set to `claude`. In that instance's **Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

Use `https://openrouter.ai/api`, not `/api/v1`. If that Claude config directory has a cached Anthropic
login, run `/logout` in a Claude Code session using that directory before starting the router setup.
Cached login credentials can conflict with the router token.

Verify requests with `/status` in a Claude session or in OpenRouter's activity dashboard. For
model-role overrides and current compatibility requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate config directory and
put the router's endpoint and credential variables in that instance's **Environment variables**. The
router must run where the environment can reach it. Follow the
[Claude Code Router instructions](https://github.com/musistudio/claude-code-router) for its
installation and routing configuration.
