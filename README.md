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

## The org chart is the access model

Three catalogues, all editable in Admin:

- **Departments** — CSM, DM, Ops, CRO
- **Teams** — each inside a department. CRO has CS, GD and SD.
- **Positions** — Manager, TL, Next Inline, Member. Each carries a **rank**
  and a default of **read** or **write**. (Observer is not a position: it is
  something you are on a single task.)

A person holds **postings**, written `dept.team.position`:

| Posting | Means |
|---|---|
| `cro.sd.tl` | TL of the SD team inside CRO |
| `cro.manager` | department-wide — every team under CRO |
| `cro.gd.member:r` | an exception: read only for this one person |

A record belongs to a department, and optionally a team. Who reaches it:

- a **department-wide** posting reaches the department and every team in it;
- a **team** posting reaches its own team, plus anything filed at the
  department itself (general department work, including the flows its tasks
  run on);
- it never reaches a **sibling team** — CRO SD does not see CRO CS;
- a record with **no department** is private to whoever made it, and admins.

### Standing in

**Next Inline** is rank 15 with an `acts` rank of 20, so they can do everything
a TL can. The difference is that TL-level acts get attributed:

- **TL-level** — moving work somebody else is holding, or signing off a step
  marked as an approval.
- **Ordinary** — passing your own finished work to the next desk, whatever
  your rank. Not singled out.

When a Next Inline does something TL-level, the hand-off record and the task
drawer say *"sent this standing in as TL"*. A real TL doing the same thing is
not flagged. Any position can be set up this way: give it an `acts` rank above
its own.

## Flows — where a task goes next

A **flow** is a routing map: the desks a task passes between, and which desk
may send it to which. It belongs to one or more tags, so you can have as many
as you like — one per department, one per kind of work.

Each step carries:

| | |
|---|---|
| **Name and colour** | what the forward button and the stage pill read |
| **Handled by** | the postings that staff this desk — `cro.sd.tl` and so on. Those are the people the step can be handed to |
| **Can be sent to** | the steps it may forward to. This is the routing: a step can branch, and send work back as well as on |
| **Target** | hours the task should sit here; past that it is flagged as over |
| **Work comes in here** | an entry point — where new tasks join the flow |
| **Approval** | marks a gate in your own process |
| **Final** | the end of the line — landing here marks the task Done |

A worked example, which is the flow the setup seeds:

```
Raised  (csm.member, dm.member, ops.member)
  → Triage (cro.manager)
      → Copy   (cro.cs.tl)   ┐
      → Design (cro.gd.tl)   ├→ Review (cro.manager)
      → Build  (cro.sd.tl, cro.sd.member) ┘
  Review → back to Copy / Design / Build, or → Delivered
```

Build one in **Flows**, which draws the whole thing as a **flowchart**: each
step is a block showing the departments that staff it, arrows show where work
can go, and a dashed curve underneath is work going back. Columns come from
the routing itself, so nothing is hand-positioned. Click a block to edit it.
Renaming a step is safe — it keeps its key, so routes pointing at it and tasks
sitting in it both survive.

Put a task on a flow in the task editor and it enters at an entry step. Then:

- The task drawer shows **Forward to** — only the destinations this flow
  actually allows from where the task is, each labelled with its desk and who
  is behind it. One click sends it.
- If one person holds that posting, it goes straight to them. If several do,
  you are asked who takes it on, and can leave a note with the hand-off.
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

Tasks do **not** follow the org chart. A task is visible only to:

- the person who raised it — always;
- anyone on its **observers** list — always;
- whoever is holding it now;
- anyone who has held it before, **but only while it is still at a desk their
  own team staffs**. Once their TL signs it off and it moves on, it drops off
  their list. If it comes back to them, so does the task.

Admins see everything. Nothing else opens a task up — not a client tag, not a
posting, not being in the same department. The drawer spells this out under
**Who can see this**, and you pull someone in by adding them as an observer.
An observer follows the task but cannot change it unless it is handed to them.

Someone posted to a whole department follows a task anywhere inside that
department; a team posting only follows it as far as that team's desks.

A task's department decides which flow and desks apply, and nothing more.

## Chat

Every task has a thread, in its drawer. It is readable by exactly the people
above and nobody else — the backend checks before it hands over a single
message. Saying something puts you on the task as a participant, so you keep
seeing the replies rather than answering a question and losing the thread.
Enter sends, Shift+Enter makes a new line.

## Task status

Alongside Todo, In Progress, Blocked and Done there is **Confirmations Sent**,
for work parked while you wait on someone else:

- picking it **clears the deadline** — there is no sense holding a date while
  the ball is in someone else's court;
- moving **off** it makes you set a new one, so a parked task cannot quietly
  lose its date for good. The editor marks the field and the backend refuses
  the save without it.

**Starting a timer puts a task In Progress** by itself. A task that is Done, or
parked waiting on confirmations, is left alone — clocking a few minutes against
it should not quietly restart it.

## Tags

Tags are **client labels only** now — BM, RW, AUJ. They say which client a
record is for, and grant nobody anything. Access is the org chart, above.

## A few more rules

You always see and edit what you own. `role = admin` adds the Admin view and
overrides every check, including the routing map.

Editing a task needs more than sight of it: you must have raised it, be holding
it, or staff the desk it is sitting at. Observers can look, not touch. Only
whoever raised a task can delete it.

All of this is enforced in the Apps Script, not the browser: bootstrap filters
rows before they leave the sheet, and every save re-checks. The UI only
reflects the `_canWrite` flag the backend stamps on each row.

## Everything else

- **Tasks** — grid or board, with a start/stop timer on every row.
- **Contacts / Clients** — with their people and tasks on the record.
- **Time** — every timer session, by person and by task, plus manual entries.
- **Admin** — people and their postings, plus the department, team, position
  and client-tag catalogues.

There is no sales pipeline: it does not fit how the work actually runs, so
Deals is gone and **Flows is what the CRM section opens on**. The Deals tab is
left untouched in the spreadsheet rather than deleted.

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
