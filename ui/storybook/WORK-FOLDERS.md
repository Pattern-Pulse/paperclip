# Work-folder design review

Run `pnpm storybook` from the repository root. Open the **Work folders** group.
The default URL is `http://localhost:6006`.

## Components

`Work folders / Components` renders the production `WorkFolderBrowser` and
`WorkFolderButton`. It includes the browser, its trigger and dialog, Markdown,
code, image and empty-file previews, unsupported/large-file messages, loading,
empty, saving, failed-save, unavailable-storage, failed-upload, trash, and
permanent-deletion confirmation states. `Upload Delete Restore` exercises the
full recovery interaction and leaves the restored file available for review.

Use **Controls** to change task/agent/project/user scope or the fixture state.
Use Storybook's theme and viewport toolbar controls for light/dark and mobile
review. The fixtures reset when you reload the story or change its controls.

## Pages

`Work folders / Pages` mounts the actual route pages inside `Layout`:

| Page             | Current entry point                                  | Stories                                                |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Task detail      | Task files above the task thread                     | Task Page, Task Files Open, Task Save Failed           |
| Agent detail     | Agent files in the detail header                     | Agent Page, Agent Files Open                           |
| Project detail   | Project files in the project header                  | Project Page, Project Files Open, Project Empty Folder |
| Profile settings | My files below the profile and inbox policy settings | Profile Settings Page, My Files Open                   |

The page stories preserve existing placement, copy, and spacing. They are a
review surface for the current implementation, not proposed redesigns. The
Open stories activate the page's real button automatically. Close the dialog
to review its surrounding page.

## Fixture boundaries

Uploads, previews, downloads, folder creation, deletion, restoration, purge,
and refresh use a fresh in-memory API per story. They do not contact a tenant,
launch agents, or persist files. Downloads contain fixture data only. Other
page mutations display an explicit unsupported-demo message. The story restores
its fetch handler and clears its isolated query cache on unmount. The loading
scenario intentionally remains pending until you leave that story.

Saving and failed states are fixed examples for visual review. Refresh shows the
real acknowledgement, but does not launch a sandbox. These stories do not replace
the deployed persistence and runner acceptance matrix.

## Supporting UI

The feature stack also changes the native runner's Pi ACPX selector and
Cloud-aware CLI authorization. **Work folders / Supporting UI** shows the real
runtime fields and the request, approved, sign-in-required, and expired CLI
pages. These use fictional challenges and cannot grant access or create keys.
The file viewer's shared rendering is covered by the component preview stories;
the design-guide examples use the same browser component.
