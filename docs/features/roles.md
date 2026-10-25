---
title: Roles and permissions
summary: Workspace roles (owner, admin, editor, viewer), what each can do, who can change roles, and ownership transfer.
status: implemented
tags: [roles, permissions, admin, members, workspace, ownership]
---

# Roles and permissions

> Roles apply to workspaces shared on a [Getman server](../guides/self-hosting.md). In a local workspace you are always the owner. Manage members in **⚙ workspace settings → Members**.

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

## Inviting

Add people by email in **Members → Add or invite**. People without an account get an invitation (email + code, 7 days); see [accounts and invitations](accounts.md).

## Leaving

Any member except the owner can leave (**General → Leave workspace**). The owner must transfer ownership first.

## Require 2FA

Owners and admins can tick **Require two-factor authentication for every member**. Members without 2FA then get "This workspace requires two-factor authentication" until they turn it on. You must have 2FA on yourself before requiring it.

## Enforcement

Every server endpoint calls `can(role, action)` from `packages/core`. The app also blocks edits a viewer cannot make (with a "Read-only" notice), but the server check is the source of truth. Every membership, role, ownership and settings change is written to the **Audit log** (admins and owner).
