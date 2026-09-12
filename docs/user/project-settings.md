# Project settings

Open **Settings → Projects**, or open a project's settings from the sidebar project filter, a
thread's menu, the chat header, or the command palette. The project and machine pickers start at **All projects** and
**All machines**.

## Defaults and overrides

With **All projects** selected, change the default model, workspace, automatic pull, agent browser
access, or actions for projects that inherit those values. Select an individual project to override
a default, and reset its row to inherit again. Changing a default keeps explicit project overrides.
A workspace preference in `t3.json` takes precedence over machine defaults when the project has no
workspace override of its own.

Select a machine to limit edits to it. **All machines** writes defaults to connected machines;
offline machines keep their previous values. When selected machines or checkouts disagree, the row
says so. Browser access changes apply when an agent session next starts. A machine running an older
Pylon server can need an update before it saves some defaults; Settings names the machines to
update.

Project grouping has a default for this client, with individual checkout overrides. Shared actions
apply to projects that inherit them; editing a project's actions creates an independent list for
that checkout, and resetting it uses shared actions again. Project names, icons, removal, and
importing actions from a checkout's `t3.json` stay specific to a project. When a project has several
checkouts, the checkout picker chooses which one to edit.

## Project icons

Select a project, then in **Project icon** choose an icon and color, an emoji, or an image from the
project. **Reset** returns to automatic selection, which checks `t3.json`, common favicon and app
icon paths, and icon links in project HTML files, then falls back to an icon chosen from the
project name.

Icon and image choices apply to the selected checkouts in a project group and appear on connected
clients. Every environment in the group must support saved icons before custom icons are available.
Pylon supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP images. Custom icons and emoji show on web and
desktop; mobile uses the project's image when one is available. Mobile **Client storage** includes
cached project images and can clear them.

## Keep the default branch current

Turn on **Automatically pull** to keep a default-branch checkout up to date with its configured
upstream. Set it under **All projects** to make it the default, or select a project to override it.

Pylon checks in the background and when the server starts. It only pulls when it can fast-forward
and the checkout has no changed files, untracked files, or local commits. It skips checkouts on
another branch or without an upstream. If a checkout has local work, resolve it yourself before
automatic pulls can resume.
