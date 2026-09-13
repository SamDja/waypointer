---
description: Pick up the card in the "Next up" column of the Waypointer Notion backlog and start work on it per the branch-per-card workflow.
---

# Work on the next Notion backlog card

Find and start work on the card sitting in the **Next up** column of the Waypointer backlog (Notion: Ideas / Sulla Via / Backlog data source, `Status` property with values To Do / Next up / Doing / Done).

## 1. Find the card

- Use the Notion MCP tools (search / fetch / query-data-sources) to locate the Backlog data source under **Ideas / Sulla Via / Backlog**, then query it for entries whose `Status` is **Next up**.
- If there are **zero** matching cards: tell the user and stop — nothing to pick up.
- If there is **exactly one**: use it.
- If there are **multiple**: list them briefly (title + Type + Priority) and ask the user which one to start.
- Fetch the full content of the chosen card (description, acceptance criteria, comments, any linked/related cards) — not just the title.

## 2. Check the card is complete

A well-formed card has two parts: **Context** (what/why) and **Action items** (what to actually do). If either is missing or too thin to act on:

- Ask the user directly for the missing piece(s) — don't guess or invent acceptance criteria.
- Once the user replies, update the Notion card with that content (filling in the missing Context and/or Action items section) before moving on, so the card stays the source of truth for next time.

## 3. Check repo state

- Run `git status` to confirm the working tree is clean and we're on (or can switch to) `main`. If there's uncommitted work, stop and ask rather than overwriting it.

## 4. Create the branch

- Read the card's `Type` property and derive `<type>`: lowercase, strip the emoji (e.g. `🐛 Bug` → `bug`, `🔧 Improvement` → `improvement`, `⭐ Feature` → `feature`).
- Derive a brief kebab-case slug from the card title.
- Create and check out a new branch off `main`: `<type>/<brief-slug>`.
- Set the card's `Status` to **Doing** in Notion.

## 5. Summarize before implementing

Before writing any code, summarize for the user in the chat:
- The card's title and Type.
- What's being asked (the actual problem/feature, in your own words, not a copy-paste).
- Any context, constraints, or acceptance criteria found on the card.
- Any related/linked cards worth knowing about.

## 6. Implement following the established workflow

This project's cards are worked one-per-branch, with review gates — see the `project_waypointer_branch_per_card` memory. Specifically:

- Implement the change.
- Verify it: backend tests (`uv run pytest`), frontend build/lint (`npm run build`, `npm run lint`), and — for any UI-visible change — an actual browser check against the dev server (not just unit tests).
- **Do not commit yet.** Wait for the user to review the work and explicitly approve before creating any commit (see `feedback_wait_for_review_before_commit` memory) — verification passing is not the same as approval.
- Once approved: commit. The branch stays unmerged until the user says it's tested/production-ready.
- Push to `origin` only if the user asks.

## 7. Wrap up

Once verification is done and the user has approved/committed (or the work is otherwise considered finished, even if partially deferred):

- Update the Notion card itself with a short "what we found / what we built / what was deferred" summary, linking the branch and noting it's not yet merged.
- Set the card's `Status` to **Review**.
