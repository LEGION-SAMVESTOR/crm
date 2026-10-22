# Setting up the CRM backend — once

About fifteen minutes, on the Google account that will own this. After this you
should never have to touch the sheet again: the script builds every tab and
column itself, and brings them up to date on its own whenever you paste a newer
version of the script.

---

## Before you start — which Google account

Use a **separate account that you own and will keep**, not a personal one you
might lose access to. Everything lives in its Drive and the script runs as it.

A plain **@gmail.com account is the safest choice.** A Google Workspace account
also works, but some Workspace domains block "share with Anyone", which this
needs — if step 3 will not let you pick **Anyone**, that is why, and a Gmail
account avoids it.

Sign into that account in a browser (or a separate Chrome profile) and stay
there for the whole of this. Mixing accounts mid-way is the single most common
way this goes wrong.

---

## 1. Create the spreadsheet

1. Go to **sheets.new** while signed in as that account.
2. Name it **CRM Backend**.

Leave it empty. Do not add tabs or headers — the script does all of that.

---

## 2. Paste the script

1. In the sheet: **Extensions ▸ Apps Script**.
2. Delete whatever is in `Code.gs` (it will be an empty `myFunction`).
3. Open `apps-script.gs` from the `crm` folder, select all, copy, and paste it
   in. All ~1,500 lines — make sure you get the whole file.
4. Rename the project if you like (top left) — it makes no difference.
5. **Save** (the disk icon, or Ctrl+S).

---

## 3. Deploy it as a web app

Still in the Apps Script editor:

1. **Deploy ▸ New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Fill in:
   - **Description**: anything, e.g. `CRM`
   - **Execute as**: **Me**
   - **Who has access**: **Anyone**
4. **Deploy**.
5. Google will ask you to authorise. It shows a warning screen because the
   script is unverified — that is expected for your own script. Click
   **Advanced ▸ Go to (project name) (unsafe) ▸ Allow**. You are granting your
   own script access to your own sheet.
6. Copy the **Web app URL**. It ends in `/exec`.

**Keep that URL.** It never changes, even when you update the script later.

> **"Anyone" does not mean your data is public.** It means anyone who knows the
> URL can *reach* the script. Every call still has to pass the ID + password
> check inside it, and returns nothing without a valid session. It has to be
> "Anyone" because people's browsers are not signed into this Google account.

---

## 4. Check it worked

Paste the `/exec` URL into a browser tab. You should see:

```json
{"ok":true,"service":"crm","version":2,"schema":"2026-10-23.1","builtJustNow":true,...}
```

Go back to the spreadsheet tab and reload it. Every tab is now there — Users,
Sessions, Departments, Teams, Positions, Tags, Lists, Companies, Contacts,
Deals, Tasks, Flows, FlowLog, TimeLog, Activity — with the starter org chart,
client tags, pipeline stages and one example routing flow.

If you instead see an HTML error page, or `builtJustNow` never goes true, jump
to **When something is wrong** at the bottom.

---

## 5. Point the app at it, permanently

So nobody ever sees a setup screen:

1. Open `api.js` in the `crm` folder.
2. Near the top, put your URL between the quotes:

   ```js
   const BAKED_URL = "https://script.google.com/macros/s/AKfyc.../exec";
   ```

3. Save. Done — the app now connects by itself on every device.

Only bake it in if you are hosting the app somewhere **not public**, since the
URL is then in the page source. If the app is going on a public site, leave
`BAKED_URL` empty and each person pastes the URL once on their own device
instead.

---

## 6. First sign-in

Serve the `crm` folder and open it:

```bash
npx -y serve -l 5190 crm
```

Sign in as **`admin`** with the password **`changeme`**.

Then, immediately: **Settings (the gear, bottom left) ▸ My password ▸ Change.**

---

## 7. Set up your people — the only real decision

Everything else is cosmetic; this part is worth getting right.

### The org chart — departments, teams, positions

This is the access model, so it is worth ten minutes.

**Admin ▸ Departments.** CSM, DM, Ops and CRO are already there. Rename,
recolour, add and delete until it is your actual org.

**Admin ▸ Teams.** Each sits inside a department — CRO has CS, GD and SD out of
the box. A department with no teams is fine.

**Admin ▸ Positions.** Manager, TL, Next Inline, Member, Observer. Each has:

| | |
|---|---|
| **Rank** | where they stand. 20 and above counts as TL-level. |
| **Acts at rank** | the rank they may exercise. Set it above their own and they can stand in, with those acts recorded as such. Next Inline is rank 15 acting at 20. |
| **Default access** | read or write, before any per-person exception. |

### Tags — who can reach which CRM data

**Admin ▸ Tags.** These gate companies, contacts, deals and flows (not tasks —
see below). Make one per client, department or team.

### People

**Admin ▸ People ▸ + User.** For each person:

| Field | What to put |
|---|---|
| User ID | lowercase, no spaces — what they type to sign in |
| Password | you set it; they change it from Settings afterwards |
| Role | `User`, or `Admin` for whoever manages people and the org chart |
| Postings | one per desk they sit at — **+ Posting**, then pick a department, optionally a team, and a position |
| Client tags | optional labels for filtering |

A posting reads `cro.sd.tl`. Leave the team as *whole department* and it
becomes `cro.manager`, which reaches every team under CRO. The position sets
read or write; the access dropdown on the posting overrides it for that one
person.

**Anyone who should receive tasks needs at least one posting.** Someone with
none can raise and watch tasks, but no flow step can be handed to them.

### Flows

**Flows ▸ + Flow**, or edit the seeded **CRO request** one. Each step names the
desks that handle it and the steps it can be sent to — that second list is the
routing. See the README for the detail.

---

## 8. Two things to know about tasks

**Tasks ignore tags.** A task is only ever visible to the person who raised it,
its watchers, whoever is holding it, and anyone who has held it. If someone
cannot see a task, the answer is always: hand it to them, or add them as a
watcher. This is deliberate — it is the rule you asked for.

**Forwarding reassigns.** Sending a task to the next desk hands it to a person
holding that desk's posting, which is what puts it in front of them.

---

## Updating the script later

When you paste a newer `apps-script.gs`:

1. Paste it over the old one and **Save**.
2. **Deploy ▸ Manage deployments ▸** pencil icon **▸ Version: New version ▸
   Deploy.**

Two things that matter: the **URL stays the same**, so nothing in `api.js` or on
anyone's device needs changing. And the sheet migrates itself on the next
request — new tabs created, new columns appended, nothing already in the sheet
moved. You never run a setup step.

The one mistake to avoid: pasting a new script and **not** redeploying. Apps
Script serves the deployed version, not the saved one, so the app keeps running
the old code. Open the `/exec` URL in a browser and check the `schema` value if
you are unsure.

---

## The CRM menu in the sheet

Reload the spreadsheet after step 3 and there is a **CRM** menu. You should not
need it, but:

- **Health check** — people, org chart, flow and task counts, plus warnings:
  nobody holding a posting some flow step is addressed to, accounts with none,
  postings naming a department, team or position that does not exist,
  flows with no entry step, no admin.
- **Rebuild sheets now** — forces the build. Safe; it never moves or deletes
  anything.
- **Clear login sessions** — signs everybody out and forces a fresh login.

---

## When something is wrong

**The `/exec` URL shows an HTML page instead of JSON.**
The deployment is private, or you copied the `/dev` URL. Redeploy with *Who has
access: Anyone* and copy the **Web app URL**, which ends `/exec`.

**"Cannot reach the sheet."**
No connection, the deployment was deleted, or `BAKED_URL` has a typo.

**Changed the script, nothing changed in the app.**
You saved but did not redeploy. See *Updating the script later*.

**Nobody can sign in.**
Open the sheet's `Users` tab. There must be a row with your user ID and a
password in either `password` (plain, which gets hashed on first sign-in) or
`passwordHash`. Typing a fresh plain password into `password` is a valid way to
reset someone.

**Locked out of the admin account.**
Type a new password into the `password` cell of the `admin` row in the sheet,
then sign in with it.

**Someone cannot see a task.**
That is the rule, not a fault. Hand it to them or add them as a watcher.

**"This flow does not go from X to Y."**
The map has no route between those steps. Open the flow and tick Y under X's
*Can be sent to*.

**"Nobody holds a posting for X yet."**
Give someone that department-team-position in Admin ▸ People.

**Someone in CRO SD cannot see CRO CS's work.**
That is the model: sibling teams are separate. A department-wide posting
(`cro.manager`) reaches both; anything filed at CRO itself, with no team, is
visible to everyone in CRO.

---

## Keep a copy

Two minutes, worth doing once:

- **File ▸ Make a copy** of the spreadsheet after you have added your people.
  Keeps a snapshot you can fall back on.
- Note the `/exec` URL somewhere you will find it again.
- Make sure someone other than you can get into that Google account.
