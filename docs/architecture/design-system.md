---
title: Design system
summary: Colour palette derived from light blue #5AB4F0, light/dark tokens, HTTP method colours and UI conventions.
status: implemented
tags: [design, colors, theme, dark-mode, ui]
---

# Design system

Tokens live in `apps/desktop/src/styles/tokens.css`. Components use **only** CSS variables, never raw colours. Theme follows the OS by default; the top-bar button cycles system → light → dark.

## Palette

| Token | Light | Dark | Use |
|---|---|---|---|
| `--primary` | `#5AB4F0` | `#5AB4F0` | Primary buttons, focus, active tab |
| `--primary-strong` | `#1E88E5` | `#8FCDF7` | Hover, links, brand text |
| `--primary-soft` | `#E3F2FD` | `#14324A` | Selected rows, hints |
| `--primary-contrast` | `#06263D` | `#04182A` | Text on primary (≈7:1 contrast) |
| `--accent` | `#FF8A65` | `#FF9C7D` | Complementary coral, warnings, highlights |
| `--success` | `#2FB380` | `#4CC994` | 2xx, passed tests |
| `--warning` | `#E0A526` | `#F0B84A` | 4xx |
| `--danger` | `#E5546A` | `#F27286` | 5xx, errors, failed tests, delete |
| `--info` | `#8E6FD1` | `#A98EE6` | PATCH |
| `--bg` / `--surface` / `--surface-2` | `#F6FAFD` / `#FFF` / `#EEF5FB` | `#0B141C` / `#111E29` / `#172836` | Layers |
| `--border` | `#D6E4F0` | `#22384A` | |
| `--text` / `--text-muted` | `#102A3C` / `#5B7488` | `#E3EEF7` / `#8AA3B8` | |

The neutrals are tinted towards the primary blue so the UI feels like one family.

## HTTP methods

GET green · POST amber · PUT blue · PATCH violet · DELETE red · HEAD/OPTIONS grey. Classes `.method-<METHOD>`.

## Conventions
- Text on `--primary` uses `--primary-contrast`, never white (white on #5AB4F0 fails WCAG AA).
- Typography: system UI font 13px; code and URLs in monospace.
- Every icon-only button has an `aria-label`.
- Destructive actions ask for confirmation.
