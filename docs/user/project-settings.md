# Customize a project icon

On web and desktop, open the sidebar project filter and select the settings button beside a
project. In **Project icon**, select **Choose icon** for an icon and color or an emoji, or
**Choose file** for an image in the project. **Reset** returns to automatic selection.

Pylon checks `t3.json`, common favicon and app icon paths, and icon links in project HTML files.
When no image is available, web and desktop choose an icon from the saved project name. The
same name determines its icon in the sidebar, chat header, command palette, and pull request
filters, even when those places display a different project label.

Icon and image choices apply to every checkout in a project group. All environments in the
group must support saved icons before **Choose icon** is available. An older environment can
still use its existing image picker.

Pylon supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP image files. Project images appear on
web, desktop, and mobile. Custom icon and emoji rendering is currently available on web and
desktop; mobile continues to use the project's image when available.

Small project images are cached on each client so they stay visible through reloads and
reconnects. Removing an environment clears its saved images. Mobile **Client storage** includes
this cache and can clear it.
