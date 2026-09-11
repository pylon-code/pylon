# Project settings

Open **Settings → Projects**. The project and machine pickers start at **All projects** and
**All machines**. You can also open a project's settings from the sidebar project filter, a
thread's menu, the chat header, or the command palette.

With **All projects** selected, change the default model, workspace, automatic pull, agent browser
access, or actions for projects that inherit those values. Select an individual project to override
a default, and reset its row to inherit again. Changing a default keeps explicit project overrides.
A workspace preference in `t3.json` takes precedence over machine defaults when the project has no
workspace override of its own.

Select a machine to limit edits to it. **All machines** writes defaults to connected machines;
offline machines keep their previous values. When selected machines or checkouts disagree, the row
says so. Browser access changes apply when an agent session next starts.

A machine running an older Pylon server still saves its workspace and browser access defaults, and
keeps each project's actions and automatic pull on that project. Its default model, automatic pull,
and action defaults, and per-project browser access, need a server update first. Settings names the
machines to update.

Project grouping has a default for this client across machines, with individual checkout overrides.
Shared actions apply to projects that inherit them; editing a project's actions creates an
independent list for that checkout. Reset that list to use shared actions again. Existing project
actions are kept.

Project names, icons, removal, and importing actions from a checkout's `t3.json` stay specific to a
project. When a project has several checkouts, the checkout picker chooses which actions and grouping
to edit.

## Project icons

Select a project, then in **Project icon** select **Choose icon** for an icon and color or an
emoji, or **Choose file** for an image in the project. **Reset** returns to automatic selection.

Pylon checks `t3.json`, common favicon and app icon paths, and icon links in project HTML files.
When no image is available, web and desktop choose an icon from the saved project name. The
same name determines its icon in the sidebar, chat header, command palette, and pull request
filters, even when those places display a different project label.

Icon and image choices apply to the selected checkouts in a project group. All environments in the
group must support saved icons before **Choose icon** is available. An older environment can
still use its existing image picker.

Pylon supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP image files. Project images appear on
web, desktop, and mobile. Custom icon and emoji rendering is currently available on web and
desktop; mobile continues to use the project's image when available.

Small project images are cached on each client so they stay visible through reloads and
reconnects. Removing an environment clears its saved images. Mobile **Client storage** includes
this cache and can clear it.

## Keep the default branch current

Turn on **Automatically pull** to keep a default-branch checkout current. Set it under **All
projects** to make it the default, or select a project to override the default for that project.
Projects that had automatic pull turned on before project defaults existed keep it on until you
change or reset them.

Pylon checks in the background and when the server starts. It uses the branch's configured
upstream and only performs a fast-forward pull when the checkout has no working-tree changes,
untracked files, or local commits.

The pull is skipped if the checkout is on another branch, has no upstream, or contains local work.
Pull failures do not prevent the server from starting.
