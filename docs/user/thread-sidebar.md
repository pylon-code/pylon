# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

To require confirmation before unpinning, enable **Settings → General → Unpin confirmation**. On web and
desktop the confirmation applies to the sidebar controls, thread menus, and the `mod+shift+p`
shortcut. Mobile unpins immediately.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

Each server stores its own copy of the automatic settlement settings and checks them even when no
web, desktop, or mobile client is connected. By default, it settles threads after three days without
activity and when their pull request merges. An eligible idle thread also settles when its pull
request closes. An open pull request does not block inactivity settlement. Active work, pending
input, and live background work keep the thread active. Pylon settles from a closed or merged
pull request only when its timestamp is not older than the user's latest activity. If that timestamp
is not available, the inactivity rule still applies. A manual un-settle also keeps the thread active.

**Settled** lists threads by when their work finished, newest first. A thread you settle yourself
sorts by the moment you settled it. A thread that settled on its own sorts by its last message or
turn, not by when the server noticed it was inactive.

Change these rules in **Settings > General**. Changes are written to connected environments whose
servers support shared settings. Offline or older environments keep their previous values and do
not appear in mismatch warnings. When eligible environments differ, choose **Apply to all** to
apply your current values to the environments named in the warning. The same applies to the
new-thread workspace mode and source control writing style. Restart continuation is shared only
with servers that support it.

A settings change affects future settlement and does not reopen a settled thread. Settings saved
by older clients on one device no longer control this behavior. When both automatic settlement
options are off, the settlement worker skips its background thread and pull-request lookups.
Turning either option back on resumes settlement checks.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

In the flat sidebar, a thread with unsent text, attachments, or context shows an amber tint and a
pen icon when it is not open. Hover its row and choose **Discard draft** to clear that content
without opening the thread. Model and mode choices are kept.

The flat sidebar's project filter stays selected when you visit Settings or reload. Choose
**All projects** to clear it. Pylon waits for connected environments to finish loading before
clearing a filter for a project that was removed.

Select several pinned threads and choose **Unpin** from the flat sidebar's context menu to unpin
them together. Your unpin confirmation setting applies. Both sidebar layouts continue bulk
deletion after a thread fails, keeping failed threads selected for retry. A worktree removal
failure is reported separately when the thread itself was deleted successfully.

On web and desktop, you can also drag files from your computer onto any thread row, including
search results: the thread opens and the files are attached in its composer, ready for your next
message. Nothing is sent automatically. The same per-message file limits apply as when attaching
files directly; see [Composer](./composer.md).

Project settings are available from the project menu in either sidebar and from the breadcrumb
context menu when composing a new thread.

## Arrange threads

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging. Other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the Pylon server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

## Pull request links

The server finds the pull request for each unsettled thread’s saved branch, even while your apps
are closed. Settled threads keep their saved links. Older servers retain client-side discovery
while the thread is visible; update them to discover and save links without an open client.

Right-click a pull request link in a thread and choose **Link to thread** to select a different
pull request. **Unlink from thread** returns to the branch pull request, if one exists. The linked
pull request participates in automatic settlement.

## Panel motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Under
**Settings → Appearance → Motion**, move the **Panel animations** slider above 0 ms to add motion.
The duration can be set up to 400 ms. Clicking the preview replays all three panel transitions; at
0 ms, it snaps between the same open and closed states.

Navigating between threads, projects, settings or pull requests restores panels immediately.
Motion applies to opening and closing a panel within the current page; reduced-motion mode
keeps those changes immediate too.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by Pylon.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While Pylon is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

## Settle finished work

Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Questions that pause the agent still
need an answer or an interrupted turn.

## Environment icons

Machine icons help distinguish environments in thread lists, connection lists, and environment pickers. Pylon detects the machine when it can and uses a server icon otherwise. Settings → Connections → Environment icon overrides the detected icon for every client connected to that environment. Choose Automatic to restore detection. Older servers keep the generic icon until updated.
