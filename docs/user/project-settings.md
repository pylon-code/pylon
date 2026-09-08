# Customize a project icon

Pylon selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

Pylon supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Project icons

Choose an icon and color or an emoji in Project Settings. Choose file uses an image from the project instead. Reset returns to automatic selection. Automatic icons use the saved project name consistently across the sidebar, chat header, command palette, and pull request filters; uploaded or discovered images remain available.

Icon and image choices apply to every checkout in a project group. All environments in the group must support saved icons before Choose icon is available. An older environment can still use its existing image picker.

Small project images are cached on each client so they stay visible through reloads and reconnects. Removing an environment clears its saved images; mobile Client storage includes and clears this cache.
