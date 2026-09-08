# Work-folder design review

Run `pnpm storybook` from the repository root. Open the **Work folders** group.
The default URL is `http://localhost:6006`.

## Current pages

The 2026-09-08 design decision removes stored-file entry points from task, agent,
project, and profile pages. Saved copies can lag behind the running sandbox and
are not a complete view of what the agent sees on disk. No replacement Files
link is added to the properties pane.

**Work folders / Pages** mounts the actual pages inside `Layout`: Task Page,
Agent Page, Project Page, Profile Settings Page, and Mobile Task Page. These show
the current UI without the removed buttons. The previous open-dialog stories
have been removed.

## Deferred inspection features

Debug inspection of persisted files and live sandbox filesystem browsing need
separate designs. Persistence, checkpointing, and the runtime APIs remain in
place; this UI change does not remove saved data or alter synchronization.

**Work folders / Stored-file prototype** retains the reusable browser for design
reference only. It is explicitly labeled as unshipped and has no entry point in
the application or Design Guide. It includes Markdown, code, image and empty-file
previews, unsupported/large-file messages, loading, empty, saving, failed-save,
unavailable-storage, failed-upload, trash, and permanent-deletion states.

Use **Controls** to change task/agent/project/user scope or the fixture state.
The toolbar supports light/dark and mobile review. Fixtures reset when you reload
the story or change its controls.

## Fixture boundaries

Prototype uploads, previews, downloads, folder creation, deletion, restoration,
purge, and refresh use fresh in-memory data. They do not contact a tenant, launch
agents, or persist files. Other page mutations display an unsupported-demo
message. The story restores its fetch handler and clears its query cache on
unmount. The loading example remains pending until you leave the story.

Saving and failed states are fixed visual examples. Refresh shows the real
acknowledgement but does not launch a sandbox. These prototypes do not replace
runtime persistence testing or implement either deferred inspection feature.

## Supporting UI

**Work folders / Supporting UI** shows the native Pi ACPX selector and the
request, approved, sign-in-required, and expired CLI authorization pages. The
fictional challenges cannot grant access or create keys.
