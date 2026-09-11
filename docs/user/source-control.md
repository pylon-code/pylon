# Source control

Pylon integrates with GitHub, GitLab, Bitbucket, and Azure DevOps to clone and publish repositories,
create pull requests, and review changes.

## Connect an account

Install Git and configure authentication on the machine running your Pylon server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**,
which shows which providers are ready and which account is signed in, and choose **Rescan**.

### GitHub

Install [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, then sign in:

```bash
gh auth login
```

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Set an access token in the server's environment:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or use an Atlassian account email and API token with read/write access to repositories and pull
requests, plus user read access (`read:user:bitbucket`):

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

The access token takes precedence if both are configured. Restart the server after changing these
variables.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign
in:

```bash
az extension add --name azure-devops
az login
```

## Clone or publish a project

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. GitHub repositories clone over HTTPS, so a
working `gh auth login` is enough; GitLab, Bitbucket, and Azure DevOps clone over SSH. Paste a full
`git@` URL to force SSH.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository, adds
it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote; make your
first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. Pylon can generate commit
messages, review titles, and descriptions from your changes.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions** uses
the project's `AGENTS.md` and recent commit subjects; Claude writers also follow `CLAUDE.md`.

When an agent finishes a turn on your thread's branch, Pylon checks for a newly opened pull request if
background activity is enabled for that repository. If a thread still shows a temporary branch name
after its worktree switches to a real branch, Pylon updates the saved name when the turn finishes,
unless other threads share that worktree.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch, or
merge. Reviews open as tabs in the right panel, and your filters, search, and sort are restored when
you return. Command-click (Control-click on Windows and Linux) a pull request number in the sidebar
to open it in your browser instead. GitLab calls these merge requests.

You can edit review titles and descriptions and your own comments where the host allows it, add a
comment when closing or reopening a review, and change labels on GitHub with triage access. GitHub,
GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also supports
approving waiting fork workflows and opening a revert pull request for a merged change.

Choose stacked or side-by-side diffs in **Settings → General → Diff layout**. Enable
**Settings → General → Proactive panels** to open a thread's linked review, and the diff of its latest
completed turn, automatically when you enter the thread or when agent work finishes.

For Azure DevOps, use the host website to view diffs or change comments. Bitbucket does not support
reopening a declined pull request.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  confirm the running server received the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS remotes
  can require separate setup from the hosting provider's API access.
- **A review cannot load:** use **Open on GitHub** or the host website while resolving connectivity,
  permissions, or rate limits.
- **Status reports a locked index:** another Git operation holds the repository's index lock. Pylon
  pauses status scans until the lock is released and leaves the lock in place.
