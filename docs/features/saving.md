---
title: Saving and unsaved changes
summary: Edits are drafts until you save (Ctrl+S, Save, Save all); what is saved immediately; drafts survive restarts; Send uses the draft; what happens when a teammate saved the same item.
status: implemented
tags: [save, draft, unsaved, ctrl+s, discard, sync, conflict, shortcuts]
---

# Saving and unsaved changes

Nothing you edit is shared with your team or written to Git until **you save it**.

## Drafts

Editing a **request**, a **collection's settings** (name, description, variables, auth, scripts), an **environment** or the **globals** creates a draft:

- a **●** appears next to the item in the sidebar (or the environment list) and **● Unsaved** in the editor;
- the top bar shows **● N unsaved · Save all**;
- drafts are stored on this device and **survive closing Getman**: you never lose an edit, even unsaved;
- **Send** uses what is on screen, so you can try a change before saving it (the code preview and the AI assistant also see the draft).

## Saving

| Action | What it saves |
|---|---|
| **Ctrl+S** (Cmd+S on macOS) or **Save** in the editor | the request or collection you are editing; in the Environments window, its unsaved environments and globals |
| **Ctrl+Shift+S** or **Save all** in the top bar | every draft of the current workspace |
| **Discard** | throws the draft away and shows the saved version again |

Saving is what syncs: in a server workspace teammates see the change immediately; in a Git workspace the files in `.getman/` are written (commit and push are still separate). In a local workspace, saving makes the change part of the workspace (and of exports).

## Saved immediately (no draft)

Creating, deleting and renaming items from the sidebar, creating or deleting environments, and importing are explicit actions and take effect at once. Deleting asks for confirmation.

**Local values** (the "Local value" column, including values set by scripts with `pm.environment.set`) are never shared, so they are kept immediately and never need saving.

## When a teammate saved the same item

If someone else saves an item after you started editing it, your draft stays on screen. When you save, Getman asks:

- **OK** saves your version (it replaces theirs);
- **Cancel** keeps your draft unsaved so you can check their change first (Discard shows their version).

If the item was deleted by someone else meanwhile, saving a request brings it back with your version.

## Read-only members

Viewers can edit and Send to experiment, but **Save** is refused (their role cannot change the workspace).
