---
title: Roles and permissions
summary: Workspace roles (owner, admin, editor, viewer), what each can do, who can change roles, and ownership transfer.
status: partial
tags: [roles, permissions, admin, members, workspace, ownership]
---

# Roles and permissions

> **Status:** the rules are implemented and tested in `packages/core/src/permissions.ts`. They take effect when workspaces can be shared (self-hosted server, phase 2). In local mode you are always the owner.

Each account owns the workspaces it creates and can grant access, including admin, to other accounts.

## Roles

| Action | Viewer | Editor | Admin | Owner |
|---|:-:|:-:|:-:|:-:|
| See collections, environments | ✅ | ✅ | ✅ | ✅ |
| Send requests | ✅ | ✅ | ✅ | ✅ |
| Create/edit collections and requests | | ✅ | ✅ | ✅ |
| Create/edit environments | | ✅ | ✅ | ✅ |
| Invite/remove members, change roles | | | ✅ | ✅ |
| Workspace settings, backups, AI key | | | ✅ | ✅ |
| Delete workspace | | | | ✅ |
| Transfer ownership | | | | ✅ |

## Changing roles

- Nobody can be made **owner** by a role change; use *Transfer ownership*.
- **Owner** can change any other member's role.
- **Admin** can manage editors and viewers and **promote them to admin**, but cannot change other admins or the owner.
- Nobody can change their own role.

## Ownership transfer

The owner picks another member. That member becomes owner and the previous owner becomes admin. There is always exactly one owner.

## Server enforcement (phase 2)

Every server endpoint calls `can(role, action)`. The UI hides actions the user cannot perform, but the server check is the source of truth.
