---
title: History, trash and simultaneous edits
summary: How Getman merges saves from several people, what happens when two people change the same request, version history of requests/collections/environments, restoring old versions, and the 30-day trash. Server workspaces.
status: implemented
tags: [history, versions, restore, undo, trash, recycle-bin, deleted, merge, conflict, collaboration, team]
---

# History, trash and simultaneous edits

Applies to workspaces on a [Getman server](../guides/self-hosting.md). In [Git workspaces](git.md), use your Git history instead; local workspaces have neither (use Export or a server).

## Several people saving at the same time

Every [save](saving.md) is merged with what others saved meanwhile, **request by request**:

- Different requests (or folders, variables, collection settings) changed by different people: **all changes are kept**, even when saved in the same second.
- The **same request** changed by two people: the version that reached the server first is kept, and the other person's version comes back to them as an **unsaved draft (●)** with a notice. Saving it again opens a **comparison** of both versions with three choices: *Save mine (replace theirs)*, *Use theirs (discard mine)*, or *Decide later*.
- A request one person deleted while another edited it: the delete stands and the editor's version comes back as a draft (saving it restores the request).

The same comparison appears whenever you save something a teammate saved after you started editing it.

Environments merge **variable by variable** the same way. Globals are saved as a whole (the last save wins, with a notice).

## Version history

Every save creates a version, recorded with **who** saved it and **when**. The last 200 versions of each collection and environment are kept.

- **One request:** open it and click **History**. The list shows the versions in which *that request* changed (created, changed, deleted). Pick one to see what differs from what you have now, and **Load into editor** to turn it into a draft; **Save** makes it current again.
- **A whole collection:** open the collection → **History** tab. Each version lists what changed (+ added, ~ changed, − deleted requests). **Restore this version** rolls the whole collection back; it is saved as a new version, so nothing is lost.
- **An environment:** Environments → **History** next to its name; same as for a request.

Secret and local values are never stored on the server, so they are not part of the history.

## Trash

Deleted **collections, folders, requests and environments** go to the trash for **30 days**: ⚙ workspace settings → **Trash**.

- Everyone in the workspace can see it; editors can **Restore** (a request or folder goes back into its folder, or to the top of the collection if that folder is gone).
- Owners and admins can **Delete forever**.
- After 30 days entries are removed automatically. For longer retention, use [backups](backup.md).
