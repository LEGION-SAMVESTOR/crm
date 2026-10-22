# CRM

A multi-user CRM with a flow builder. Vanilla HTML/CSS/JS, no build step. The
backend is a Google Sheet driven by an Apps Script web app — no database, no
server to keep running.

```
index.html        the shell: rail, top bar, views, drawer, modal
style.css         the design system
api.js            the only thing that talks to the backend
app.js            all of the behaviour
apps-script.gs    paste this into the sheet's Apps Script editor
SETUP.md          step by step, start to finish
```

## The layout

A fixed left rail (scope + navigation + who you are), a top bar (breadcrumb,
search, + New), a per-view tool bar of filters, then the work itself: a dense
grid, a board, or the flow canvas. Records open in a right-hand drawer rather
than a dialog, so you keep your place in the list. The running timer lives in
the status bar along the bottom and is visible from every view.

**Scope**, at the top of the rail, narrows every view to one tag — a
department, a client, a team. It is a lens, not a permission: it cannot show
you anything your tags do not already allow.

## Badges

A **badge** is a desk, not a person: CSM, DM, Ops, CRO Manager, CRO CS, CRO GD,
CRO SD TL, CRO SD. People wear one or more of them (Admin ▸ People). Badges are
what flows route to — a step says "CRO GD handles this", and anyone wearing
that badge can be handed it.

## Flows — where a task goes next

A **flow** is a routing map: the desks a task passes between, and which desk
may send it to which. It belongs to one or more tags, so you can have as many
as you like — one per department, one per kind of work.

Each step carries:

| | |
|---|---|
| **Name and colour** | what the forward button and the stage pill read |
| **Handled by** | the badges that staff this desk — who the step can be handed to |
| **Can be sent to** | the steps it may forward to. This is the routing: a step can branch, and send work back as well as on |
| **Target** | hours the task should sit here; past that it is flagged as over |
| **Work comes in here** | an entry point — where new tasks join the flow |
| **Approval** | marks a gate in your own process |
| **Final** | the end of the line — landing here marks the task Done |

A worked example, which is the flow the setup seeds:

```
Raised (CSM, DM, Ops) → Triage (CRO Manager) → Copy (CRO CS) ─┐
                                             → Design (CRO GD) ┤→ Review (CRO Manager)
                                             → Build (CRO SD TL, CRO SD) ─┘
                        Review → back to Copy / Design / Build, or → Delivered
```

Build one in **Flows**: drag step cards to reorder, `+` between two cards to
insert one, tick the badges that handle it and the steps it can go to, then
**Save flow**. Renaming a step is safe — it keeps its key, so routes pointing
at it and tasks sitting in it both survive.

Put a task on a flow in the task editor and it enters at an entry step. Then:

- The task drawer shows **Forward to** — only the destinations this flow
  actually allows from where the task is, each labelled with its badge and who
  is behind it. One click sends it.
- If one person wears the badge, it goes straight to them. If several do, you
  are asked who takes it on, and can leave a note with the hand-off.
- Forwarding **reassigns** the task. Whoever receives it can now see and work
  on it; everyone who has held it stays on the task as a participant.
- The backend refuses a move the map does not allow, so the route is real
  rather than advisory. Admins can override.
- **Tasks ▸ Board**, with that flow selected, gives you a column per desk.
  Drag a card across to forward it.
- Every hand-off is written to a `FlowLog` tab — which desk, who held it, who
  sent it, how long it sat and any note — so **Hand-offs** in the drawer is
  real data.
- The dashboard rolls this up: **Stage load** shows where work is piling up,
  **Past stage target** what has been sitting too long.

Flows sit alongside status rather than replacing it — a one-off task needs no
flow at all, and keeps plain Todo / In Progress / Done.

## Who can see a task

Tasks do **not** follow tags. A task is visible only to:

- the person who raised it,
- anyone on its watchers list,
- whoever is holding it now,
- anyone who has held it along the way (its participants),

plus admins. Nothing else opens it up — not a tag, not a badge, not being in
the same department. The drawer spells this out under **Who can see this**, and
you pull someone in by adding them as a watcher. A watcher can follow the task
but cannot change it unless it is handed to them.

Tags on a task decide which flow and badges apply, and nothing more.

## Access to everything else

Companies, contacts, deals and flows hang off tags. A person's `tags` cell in
the `Users` tab:

| Entry | Means |
|---|---|
| `cro` | read **and** write anything tagged `cro` |
| `cro:r` | read only — the UI locks, the backend refuses writes |
| `*` | everything |

On top of that you always see and edit what you own, and a record with **no**
tags is private to its owner and admins — which is why the editor pre-selects a
writable tag on anything new. `role = admin` adds the Admin view and overrides
every check.

Flows obey these rules: a flow tagged `bm` is invisible to someone without
`bm`, and read-only to someone holding `bm:r`.

Editing a task needs more than sight of it: you must have raised it, be holding
it, or wear a badge for the desk it is sitting at. Watchers can look, not
touch. Only whoever raised a task can delete it.

All of this is enforced in the Apps Script, not the browser: bootstrap filters
rows before they leave the sheet, and every save re-checks. The UI only
reflects the `_canWrite` flag the backend stamps on each row.

## Everything else

- **Tasks** — grid or board, with a start/stop timer on every row.
- **Deals** — a drag-and-drop pipeline, or a grid.
- **Contacts / Companies** — with their people, deals and tasks on the record.
- **Time** — every timer session, by person and by task, plus manual entries.
- **Admin** — people, their tags and badges, the badge catalogue and the tag
  catalogue.

## Running it

Static files — serve the folder from anywhere. [SETUP.md](SETUP.md) walks the
backend through end to end; it is a one-time job.

The app finds the backend either from `BAKED_URL` at the top of `api.js` (set
it and nobody ever sees a setup screen) or, if that is empty, by asking each
device once and keeping the answer in its `localStorage`.

The sheet looks after itself: the script creates every tab and column on first
contact, and migrates them on its own whenever you paste a newer version. There
is no setup step to run, now or later.

```bash
npx -y serve -l 5190 crm
```

## Notes

- Deliberately **online-first**: CRM data is shared, so every write goes
  straight to the sheet and the reply is what the UI trusts. Nothing is queued
  locally, so two people cannot silently overwrite each other with a stale
  snapshot. A dropped connection is a visible error, not a quiet divergence.
- One timer per person. Starting a second task closes the first.
- Keyboard: `/` focuses search, `Esc` closes the drawer or dialog.
- Adding a field is two lines — one in `HEAD` in `apps-script.gs`, one in
  `SPEC` in `app.js`. The editor, drawer and grid all generate from there.
