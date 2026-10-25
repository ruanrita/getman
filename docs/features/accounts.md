---
title: Accounts, invitations and password reset
summary: Server accounts - sign up, email verification, inviting people who have no account, invite codes, forgot password, and what works when the server has no email (SMTP).
status: implemented
tags: [account, sign-up, invite, invitation, email, verify, password, reset, forgot-password, smtp]
---

# Accounts, invitations and password reset

Accounts exist on a [Getman server](../guides/self-hosting.md). Getman is a desktop app, so emails contain **codes you type in the app**, not links.

## Sign up and verify your email

**Sign in → Create account** on the server. If the server can send email, you receive a **6-digit code**: open **Account → Verify your email**, enter it, done. **Send me a code** sends a new one (at most one per minute; codes expire after 30 minutes and allow 5 attempts).

The account works before verifying, but **invitations are only collected after verifying** (it proves the address is yours).

## Inviting people

In **⚙ workspace settings → Members → Add or invite**, enter an email and a role:

- **Has an account on this server** → added at once.
- **No account yet** → an **invitation** is created (valid 7 days). If the server can send email, they get an email with instructions and an **invite code**; the code is also shown to you, so you can share it in chat.

The invited person then either:
1. creates an account with **that email address** and verifies it → joins automatically, or
2. signs in and enters the code under **Account → Have an invite code?**

An invite code only works for the address it was sent to. **Pending invitations** in the Members tab can be **resent** (new code; the old one stops working) or **cancelled**. Owners and admins can invite. Invitations created, accepted and cancelled appear in the audit log.

## Forgot password

**Sign in → Forgot password?** → enter your email → you receive an **8-digit code** → enter it with a new password. Resetting signs you out on every device and also counts as verifying your email. Two-factor authentication stays on.

For privacy, the server answers the same way whether or not an account exists.

## When the server cannot send email

If the administrator has not configured SMTP:
- invitations still work through the **code shown to the admin**;
- email verification is not available (not required to use Getman);
- "Forgot password?" tells you to ask the administrator, who runs `node dist/admin.js reset-password <email>` on the server to get a temporary password (`docker compose exec server node dist/admin.js reset-password <email>` with Docker). Change it afterwards under **Account → Change password**.
