"use strict";
/* ============================================================================
   CRM — front end.

   Layout: fixed rail, top bar, per-view tool bar, dense grid, right-hand
   drawer for detail, centred modal for forms, status bar that always carries
   the running timer.

   The piece worth knowing about is FLOWS. A flow is a named, ordered list of
   stages scoped to tags. A task may be put on a flow; it then has a current
   stage, every move is written to FlowLog with how long the task sat there,
   and the board groups by stage instead of status. Flows live alongside
   status rather than replacing it: a one-off task needs no flow at all.

   Access stays the sheet's business. The backend only sends rows this person
   may read and stamps each with _canWrite; the UI just respects that.
   ========================================================================== */

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = s => String(s === null || s === undefined ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const lc = s => String(s || "").toLowerCase();
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDay(iso) {
  if (!iso) return "";
  const p = String(iso).slice(0, 10).split("-");
  if (p.length !== 3) return String(iso);
  return Number(p[2]) + " " + (MONTHS[Number(p[1]) - 1] || p[1]);
}
function fmtClock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function isoOffset(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const todayIso = () => isoOffset(0);
function fmtMins(m) {
  m = Math.max(0, Math.round(Number(m) || 0));
  const h = Math.floor(m / 60);
  return h ? h + "h " + String(m % 60).padStart(2, "0") + "m" : m + "m";
}
function fmtAge(mins) {                      // how long something has sat
  mins = Math.max(0, Math.round(mins));
  if (mins < 60) return mins + "m";
  if (mins < 1440) return Math.round(mins / 60) + "h";
  return Math.round(mins / 1440) + "d";
}
function hhmmss(sec) {
  sec = Math.max(0, Math.floor(sec));
  return Math.floor(sec / 3600) + ":" + String(Math.floor((sec % 3600) / 60)).padStart(2, "0") +
         ":" + String(sec % 60).padStart(2, "0");
}
const money = v => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const tagsOf = v => String(v || "").split(/[,;\n]/).map(t => t.trim().toLowerCase()).filter(Boolean);
const initials = s => String(s || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ---------- state ---------- */
const state = {
  user: null,
  data: { companies: [], contacts: [], tasks: [], flows: [], flowlog: [], time: [],
          tags: [], departments: [], teams: [], positions: [], lists: {}, people: [] },
  running: null,
  users: [],
  view: "dash",
  scope: localStorage.getItem("crm.scope") || "",     // a tag, or "" for all
  q: "",
  filters: {},
  sort: {},
  mode: { tasks: "grid" },
  flowSel: null,
  flowDraft: null,
  parked: "Confirmations Sent",   // the status that clears a task's deadline
  msgCounts: {},
  messages: {},                   // taskId -> the thread, fetched when opened
  autoSeconds: Number(localStorage.getItem("crm.autoRefresh") || 300),
  tick: null, autoTimer: null
};

const byId = (list, id) => list.find(r => r.id === id) || null;
const company = id => byId(state.data.companies, id);
const contact = id => byId(state.data.contacts, id);
const taskOf  = id => byId(state.data.tasks, id);
const flowOf  = id => byId(state.data.flows, id);
function personName(uid) {
  const p = state.data.people.find(p => lc(p.userId) === lc(uid));
  return p ? p.name : (uid || "");
}
function whoHtml(uid) {
  if (!uid) return '<span class="ro">unassigned</span>';
  const n = personName(uid);
  return `<span class="who"><span class="av">${esc(initials(n))}</span>${esc(n)}</span>`;
}

/* ---------- tags, lists ---------- */
function tagMeta(tag) {
  return state.data.tags.find(t => t.tag === lc(tag)) || { tag: lc(tag), label: tag, colour: "#8b98a6" };
}
const tagHtml = tag => {
  const m = tagMeta(tag);
  return `<span class="tag" style="--c:${esc(m.colour)}">${esc(m.label)}</span>`;
};
function tagsHtml(v) {
  const list = tagsOf(v);
  return list.length ? `<span class="tags">${list.map(tagHtml).join("")}</span>` : '<span class="ro">private</span>';
}
// tags are client labels now — anyone may put one on anything they can edit
const canWriteTag = () => true;

function listMeta(type, value) {
  return (state.data.lists[type] || []).find(o => lc(o.value) === lc(value)) ||
         { value, label: value, colour: "#8b98a6" };
}
function pillHtml(type, value) {
  if (!value) return '<span class="ro">—</span>';
  const m = listMeta(type, value);
  return `<span class="pill" style="--c:${esc(m.colour)}"><span class="dot"></span>${esc(m.label)}</span>`;
}

/* ---------- the org chart: departments, teams, positions ----------
   A posting is written dept.team.position ("cro.sd.tl"), or dept.position for
   the whole department. It is both who someone is and what they can reach. */
const deptMeta = d => state.data.departments.find(x => x.dept === lc(d)) ||
  { dept: lc(d), label: d || "—", colour: "#8b98a6" };
const teamMeta = t => state.data.teams.find(x => x.team === lc(t)) ||
  { team: lc(t), label: t || "", dept: "", colour: "#8b98a6" };
const posMeta = p => state.data.positions.find(x => x.position === lc(p)) ||
  { position: lc(p), label: p || "", rank: 10, acts: 10, access: "write", colour: "#8b98a6" };

const teamsIn = dept => state.data.teams.filter(t => t.dept === lc(dept));

function deptHtml(d) {
  if (!d) return '<span class="ro">—</span>';
  const m = deptMeta(d);
  return `<span class="badge" style="--c:${esc(m.colour)}">${esc(m.label)}</span>`;
}
// "CRO › SD" for a record, or just the department
function scopeHtml(dept, team) {
  if (!dept) return '<span class="ro">private</span>';
  let h = deptHtml(dept);
  if (team) {
    const t = teamMeta(team);
    h += `<span class="sep">›</span><span class="badge" style="--c:${esc(t.colour)}">${esc(t.label)}</span>`;
  }
  return `<span class="tags">${h}</span>`;
}

// parse "cro.sd.tl:r" into its parts
function parsePosting(raw) {
  let s = lc(raw).trim();
  if (!s) return null;
  if (s === "*") return { all: true, label: "Everything" };
  let override = "";
  const m = s.match(/:(r|w|read|write)$/);
  if (m) { override = m[1][0] === "r" ? "read" : "write"; s = s.replace(/:(r|w|read|write)$/, ""); }
  const bits = s.split(".").filter(Boolean);
  if (bits.length < 2) return null;
  const position = bits[bits.length - 1];
  const p = posMeta(position);
  return {
    dept: bits[0],
    team: bits.length >= 3 ? bits[1] : "",
    position, override,
    access: override || p.access,
    rank: p.rank, acts: p.acts
  };
}
const postingsOf = cell => String(cell || "").split(/[,;\n]/).map(parsePosting).filter(Boolean);

function postingHtml(p) {
  if (!p) return "";
  if (p.all) return `<span class="badge" style="--c:#2dd4bf">Everything</span>`;
  const d = deptMeta(p.dept), t = p.team ? teamMeta(p.team) : null, pos = posMeta(p.position);
  return `<span class="posting" style="--c:${esc(d.colour)}">` +
    `<b>${esc(d.label)}</b>` +
    (t ? `<span class="sep">›</span>${esc(t.label)}` : "") +
    `<span class="sep">›</span><span class="pos" style="--c:${esc(pos.colour)}">${esc(pos.label)}</span>` +
    (p.access === "read" ? `<span class="ro"> read</span>` : "") +
    `</span>`;
}
const postingsHtml = cell => {
  const list = postingsOf(cell);
  return list.length ? `<span class="tags">${list.map(postingHtml).join("")}</span>` : '<span class="ro">none</span>';
};
const postingText = p => p.all ? "*" :
  p.dept + (p.team ? "." + p.team : "") + "." + p.position + (p.override === "read" ? ":r" : "");

// "CRO › SD › TL" from a posting string, for prose and buttons
function deskLabel(target) {
  const p = parsePosting(target);
  if (!p) return target;
  if (p.all) return "Everything";
  return [deptMeta(p.dept).label, p.team ? teamMeta(p.team).label : null, posMeta(p.position).label]
    .filter(Boolean).join(" › ");
}
const desksHtml = list => {
  const l = (list || []).filter(Boolean);
  return l.length ? `<span class="tags">${l.map(t => postingHtml(parsePosting(t))).join("")}</span>`
                  : '<span class="ro">anyone</span>';
};

/* does a posting pattern cover a department/team, or match a step target */
function patternMatches(p, target) {
  const bits = lc(target).split(".").filter(Boolean);
  if (bits.length < 2) return false;
  const dept = bits[0], team = bits.length >= 3 ? bits[1] : "", position = bits[bits.length - 1];
  if (p.dept !== dept || p.position !== position) return false;
  if (team && p.team && p.team !== team) return false;
  return true;
}
// everyone who could take a step on
function staffForStep(step) {
  if (!step || !step.to || !step.to.length) return state.data.people.slice();
  return state.data.people.filter(person =>
    (person.posts || []).some(post =>
      step.to.some(t => patternMatches(
        { dept: post.dept, team: post.team, position: post.position }, t))));
}
const myPostings = () => postingsOf(state.user.postings);
// the departments and teams this person can write to, for new records
function myWritableScopes() {
  if (state.user.all) {
    const out = [];
    state.data.departments.forEach(d => {
      out.push({ dept: d.dept, team: "" });
      teamsIn(d.dept).forEach(t => out.push({ dept: d.dept, team: t.team }));
    });
    return out;
  }
  return myPostings().filter(p => !p.all && p.access === "write")
    .map(p => ({ dept: p.dept, team: p.team }));
}
function canWriteScope(dept, team) {
  if (!dept) return true;
  if (state.user.all) return true;
  return myPostings().some(p => !p.all && p.access === "write" && p.dept === lc(dept) &&
    (!p.team || !team || p.team === lc(team)));
}

/* ---------- flow helpers ---------- */
const flowStages = f => (f && f.stages) || [];
function stageOf(flow, key) {
  return flowStages(flow).find(s => s.key === key) || null;
}
// where a task may be sent from where it is now
function nextSteps(flow, fromKey) {
  const steps = flowStages(flow);
  if (!fromKey) {
    const entries = steps.filter(s => s.entry);
    return entries.length ? entries : (steps.length ? [steps[0]] : []);
  }
  const here = stageOf(flow, fromKey);
  if (!here) return steps.slice();
  const keys = here.next && here.next.length
    ? here.next
    : (steps[steps.indexOf(here) + 1] ? [steps[steps.indexOf(here) + 1].key] : []);
  return keys.map(k => stageOf(flow, k)).filter(Boolean);
}
function taskStage(t) {
  const f = flowOf(t.flowId);
  return f ? stageOf(f, t.stage) : null;
}
function stageHtml(t) {
  const f = flowOf(t.flowId);
  if (!f) return '<span class="ro">—</span>';
  const s = stageOf(f, t.stage);
  if (!s) return `<span class="ro">${esc(f.name)} · not started</span>`;
  const late = stageOverdue(t, s);
  return `<span class="pill" style="--c:${esc(s.colour)}"><span class="dot"></span>${esc(s.name)}</span>` +
         (late ? ` <span class="late" title="past this stage's ${s.slaHours}h target">${esc(fmtAge(late))} over</span>` : "");
}
// the open FlowLog row for a task is the one it is sitting in now
function openStageLog(taskId) {
  return state.data.flowlog.find(l => l.taskId === taskId && !l.exitedAt) || null;
}
// minutes past the stage's SLA, or 0
function stageOverdue(t, s) {
  if (!s || !s.slaHours || s.terminal) return 0;
  const log = openStageLog(t.id);
  if (!log) return 0;
  const mins = (Date.now() - new Date(log.enteredAt).getTime()) / 60000;
  return mins > s.slaHours * 60 ? mins - s.slaHours * 60 : 0;
}
function stageAge(t) {
  const log = openStageLog(t.id);
  return log ? (Date.now() - new Date(log.enteredAt).getTime()) / 60000 : 0;
}
// flows this person may put work on, inside the current scope
function usableFlows() {
  return state.data.flows.filter(f => f.active !== false && inScope(f));
}

/* ---------- scope: the rail's department / team lens ----------
   "cro" is the whole department, "cro.sd" just that team. It narrows the
   view; it never shows anything a posting does not already allow. */
function inScope(r) {
  if (!state.scope) return true;
  const bits = state.scope.split(".");
  if (lc(r.dept) !== bits[0]) return false;
  if (bits[1] && lc(r.team) && lc(r.team) !== bits[1]) return false;
  return true;
}
function scopeLabel(s) {
  if (!s) return "Whole org";
  const bits = s.split(".");
  const d = deptMeta(bits[0]).label;
  return bits[1] ? d + " › " + teamMeta(bits[1]).label : d;
}

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast on" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, kind === "err" ? 5200 : 2500);
}

/* ============================================================================
   FIELD SPECS
   ========================================================================== */
const SPEC = {
  Companies: {
    label: "Company", plural: "Companies", title: r => r.name,
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "website", label: "Website", type: "text" },
      { key: "phone", label: "Phone", type: "text" },
      { key: "city", label: "City", type: "text" },
      { key: "owner", label: "Owner", type: "person" },
      { key: "scope", label: "Belongs to", type: "scope", full: true,
        hint: "The department, and the team inside it, that this belongs to. That is what decides who can reach it. Leave it blank and only you and admins can." },
      { key: "tags", label: "Client", type: "tags", full: true,
        hint: "A label only — which client this is for. It grants nobody anything." },
      { key: "notes", label: "Notes", type: "textarea", full: true }
    ]
  },
  Contacts: {
    label: "Contact", plural: "Contacts", title: r => r.name,
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "title", label: "Job title", type: "text" },
      { key: "companyId", label: "Company", type: "company" },
      { key: "email", label: "Email", type: "text" },
      { key: "phone", label: "Phone", type: "text" },
      { key: "status", label: "Status", type: "select", list: "contactStatus" },
      { key: "owner", label: "Owner", type: "person" },
      { key: "scope", label: "Belongs to", type: "scope", full: true },
      { key: "tags", label: "Client", type: "tags", full: true },
      { key: "notes", label: "Notes", type: "textarea", full: true }
    ]
  },
  Tasks: {
    label: "Task", plural: "Tasks", title: r => r.title,
    fields: [
      { key: "title", label: "Task", type: "text", required: true },
      { key: "flowId", label: "Flow", type: "flow",
        hint: "Put the task on a flow and it moves through that flow's stages. Leave it off for a one-off." },
      { key: "status", label: "Status", type: "select", list: "taskStatus" },
      { key: "priority", label: "Priority", type: "select", list: "priority" },
      { key: "dueDate", label: "Due", type: "date" },
      { key: "assignee", label: "Assigned to", type: "person" },
      { key: "linkType", label: "Attached to", type: "select",
        options: [{ value: "", label: "Nothing" }, { value: "Companies", label: "Company" },
                  { value: "Contacts", label: "Contact" }] },
      { key: "linkId", label: "Which one", type: "link" },
      { key: "scope", label: "Belongs to", type: "scope", full: true,
        hint: "Which department and team this task is for. It picks the flow and the desks — it does not let anyone see the task. Only the people on it can." },
      { key: "tags", label: "Client", type: "tags", full: true },
      { key: "observers", label: "Observers", type: "people", full: true,
        hint: "Observers can see the task and follow it, but cannot change it unless it is handed to them." },
      { key: "notes", label: "Notes", type: "textarea", full: true }
    ]
  }
};

function linkLabel(r) {
  if (!r.linkType || !r.linkId) return "";
  if (r.linkType === "Companies") { const c = company(r.linkId); return c ? c.name : "—"; }
  if (r.linkType === "Contacts") { const c = contact(r.linkId); return c ? c.name : "—"; }
  return "";
}

/* ============================================================================
   BOOT
   ========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.theme = localStorage.getItem("crm.theme") || "dark";
  wire();
  if (!API.url()) gate("setup");
  else if (!API.token()) gate("login");
  else resume();
});

function gate(which, msg) {
  $("gateSetup").classList.toggle("on", which === "setup");
  $("gateLogin").classList.toggle("on", which === "login");
  $("shell").classList.toggle("up", which === "app");
  if (which === "setup") { $("setupUrl").value = API.url(); $("setupErr").textContent = msg || ""; $("setupUrl").focus(); }
  if (which === "login") { $("loginHost").textContent = API.host(); $("loginErr").textContent = msg || ""; $("loginId").focus(); }
}

async function resume() {
  state.user = API.user();
  gate("app");
  sync("busy", "Loading");
  try { await reload(); }
  catch (err) {
    if (err.code === "auth") return gate("login", "Session ended — sign in again.");
    if (err.code === "config") return gate("setup", err.message);
    sync("err", "Offline");
    toast(err.message, "err");
  }
}

async function reload() {
  const r = await API.bootstrap();
  state.user = r.user;
  API.setUser(r.user);
  state.data = {
    companies: r.companies || [], contacts: r.contacts || [],
    tasks: r.tasks || [], flows: r.flows || [], flowlog: r.flowlog || [],
    time: r.time || [], tags: r.tags || [],
    departments: r.departments || [], teams: r.teams || [], positions: r.positions || [],
    lists: r.lists || {}, people: r.people || []
  };
  state.parked = r.parkedStatus || "Confirmations Sent";
  state.msgCounts = r.msgCounts || {};
  state.running = r.running || null;
  // a scope tag that no longer exists would silently hide everything
  if (state.scope && !state.data.departments.some(d => d.dept === state.scope.split(".")[0])) setScope("");
  sync("ok", "Synced");
  paint();
  if (state.view === "admin") loadAdmin();
  armAuto();
}

function sync(kind, text) {
  $("syncDot").className = "seg-dot " + (kind || "");
  $("syncText").textContent = text || "";
}

function armAuto() {
  clearTimeout(state.autoTimer);
  if (!state.autoSeconds) return;
  state.autoTimer = setTimeout(async () => {
    // never pull the floor out from under an open dialog or a half-built flow
    const busy = $("modal").classList.contains("on") || $("drawer").classList.contains("on") || state.flowDraft;
    if (!busy) { try { await reload(); } catch (e) {} }
    armAuto();
  }, state.autoSeconds * 1000);
}

/* ============================================================================
   WIRING
   ========================================================================== */
function wire() {
  $("btnConnect").onclick = () => {
    const u = $("setupUrl").value.trim();
    if (!/^https:\/\/script\.google\.com\/.*\/exec$/.test(u)) {
      $("setupErr").textContent = "That should be a script.google.com URL ending in /exec.";
      return;
    }
    API.setUrl(u); gate("login");
  };
  $("setupUrl").addEventListener("keydown", e => { if (e.key === "Enter") $("btnConnect").click(); });
  // with the URL baked into api.js there is nothing to change on the device
  if (API.baked()) {
    $("btnRewire").style.display = "none";
  } else {
    $("btnRewire").onclick = () => gate("setup");
  }

  $("loginForm").onsubmit = async e => {
    e.preventDefault();
    const id = $("loginId").value.trim(), pw = $("loginPw").value;
    if (!id || !pw) { $("loginErr").textContent = "Both fields, please."; return; }
    $("btnLogin").disabled = true; $("loginErr").textContent = "";
    try { await API.login(id, pw); $("loginPw").value = ""; await resume(); }
    catch (err) {
      $("loginErr").textContent = err.message;
      if (err.code === "config") gate("setup", err.message);
    } finally { $("btnLogin").disabled = false; }
  };

  $("btnReload").onclick = async () => {
    sync("busy", "Loading");
    try { await reload(); toast("Up to date", "ok"); }
    catch (err) { sync("err", "Failed"); toast(err.message, "err"); }
  };
  $("btnOut").onclick = async () => {
    await API.logout(); clearTimeout(state.autoTimer); gate("login", "Signed out.");
  };
  $("btnSettings").onclick = openSettings;
  $("btnRail").onclick = () => $("rail").classList.toggle("open");
  $("scopeBtn").onclick = openScopePicker;
  $("btnNew").onclick = () => newForView();

  $("gq").addEventListener("input", e => { state.q = e.target.value.trim(); paintView(); });

  $("btnDrawerClose").onclick = closeDrawer;
  $("scrim").onclick = closeDrawer;
  $("btnModalCancel").onclick = closeModal;
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if ($("modal").classList.contains("on")) closeModal();
      else if ($("drawer").classList.contains("on")) closeDrawer();
    }
    // "/" focuses search unless something is already being typed into
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault(); $("gq").focus();
    }
  });

  $("btnNewUser").onclick = () => editUser(null);
  $("btnNewTag").onclick = () => editTag(null);
  $("btnNewDept").onclick = () => editOrg("Departments", null);
  $("btnNewTeam").onclick = () => editOrg("Teams", null);
  $("btnNewPos").onclick  = () => editOrg("Positions", null);
  $("btnRunStop").onclick = stopTimer;
  $("btnRunOpen").onclick = () => {
    if (!state.running) return;
    const t = taskOf(state.running.taskId);
    if (t) { go("tasks"); openDrawer("Tasks", t.id); }
  };

  startTicker();
}

/* ---------- delegated row actions ---------- */
document.addEventListener("click", async e => {
  const edit = e.target.closest("[data-edit]");
  if (edit) { e.stopPropagation(); return openEditor(edit.dataset.edit, edit.dataset.id); }

  const timer = e.target.closest("[data-timer]");
  if (timer) {
    e.stopPropagation();
    const id = timer.dataset.timer;
    return (state.running && state.running.taskId === id) ? stopTimer() : startTimer(id);
  }
  const tsess = e.target.closest("[data-session]");
  if (tsess) { e.stopPropagation(); return editSession(state.data.time.find(t => t.id === tsess.dataset.session) || null); }

  const usr = e.target.closest("[data-user]");
  if (usr) { e.stopPropagation(); return editUser(state.users.find(x => x.userId === usr.dataset.user) || null); }

  const tg = e.target.closest("[data-tagedit]");
  if (tg) { e.stopPropagation(); return editTag(state.data.tags.find(x => x.tag === tg.dataset.tagedit) || null); }

  const org = e.target.closest("[data-org]");
  if (org) {
    e.stopPropagation();
    const kind = org.dataset.org, key = org.dataset.key;
    const src = { Departments: state.data.departments, Teams: state.data.teams, Positions: state.data.positions }[kind];
    const col = { Departments: "dept", Teams: "team", Positions: "position" }[kind];
    return editOrg(kind, (src || []).find(x => x[col] === key) || null);
  }

  const fwd = e.target.closest("[data-forward]");
  if (fwd) { e.stopPropagation(); return forward(fwd.dataset.task, fwd.dataset.forward); }

  const unw = e.target.closest("[data-unwatch]");
  if (unw) { e.stopPropagation(); return setObserver(unw.dataset.task, unw.dataset.unwatch, true); }
});

/* ============================================================================
   NAV
   ========================================================================== */
const NAV = [
  { group: "Work", items: [
    { id: "dash",  label: "Dashboard", ic: "▦" },
    { id: "tasks", label: "Tasks",     ic: "✓", count: () => scoped(state.data.tasks).filter(t => t.status !== "Done").length }
  ] },
  { group: "CRM", items: [
    { id: "flows",     label: "Flows",     ic: "⇥", count: () => usableFlows().length },
    { id: "contacts",  label: "Contacts",  ic: "☺", count: () => scoped(state.data.contacts).length },
    { id: "companies", label: "Clients",   ic: "▣", count: () => scoped(state.data.companies).length }
  ] },
  { group: "Insight", items: [ { id: "time", label: "Time", ic: "◷" } ] },
  { group: "System", items: [ { id: "admin", label: "Admin", ic: "⚙", admin: true } ] }
];

const scoped = list => list.filter(inScope);

function renderRail() {
  $("meAv").textContent = initials(state.user.name);
  $("meName").textContent = state.user.name;
  $("meRole").textContent = state.user.role === "admin" ? "Administrator"
    : state.user.all ? "Everything"
    : (myPostings().map(p => deskLabel(postingText(p))).join(" · ") || "No posting");
  $("brandSub").textContent = state.scope ? scopeLabel(state.scope) : "whole org";
  $("scopeVal").textContent = scopeLabel(state.scope);

  const wrap = $("navGroups");
  wrap.innerHTML = "";
  NAV.forEach(g => {
    const items = g.items.filter(i => !i.admin || state.user.role === "admin");
    if (!items.length) return;
    const box = el("div", "navgroup");
    box.appendChild(el("h4", "", esc(g.group)));
    items.forEach(i => {
      const b = el("button", "navitem" + (state.view === i.id ? " on" : ""));
      const n = i.count ? i.count() : 0;
      b.innerHTML = `<span class="ic">${i.ic}</span><span>${esc(i.label)}</span>` +
                    (n ? `<span class="cnt">${n}</span>` : "");
      b.onclick = () => { go(i.id); $("rail").classList.remove("open"); };
      box.appendChild(b);
    });
    wrap.appendChild(box);
  });
}

function go(id) {
  if (id === "admin" && state.user.role !== "admin") id = "dash";
  state.view = id;
  state.q = ""; $("gq").value = "";
  document.querySelectorAll(".view").forEach(v => v.classList.remove("on"));
  const v = $("v-" + id);
  if (v) v.classList.add("on");
  renderRail();
  renderCrumbs();
  paintView();
  if (id === "admin") loadAdmin();
  $("content").scrollTop = 0;
}

function renderCrumbs() {
  const label = (NAV.flatMap(g => g.items).find(i => i.id === state.view) || {}).label || "";
  const scope = scopeLabel(state.scope);
  $("crumbs").innerHTML =
    `<span>${esc(scope)}</span><span class="sep">›</span><b>${esc(label)}</b>`;
}

function newForView() {
  const map = { tasks: "Tasks", contacts: "Contacts", companies: "Companies" };
  if (state.view === "flows") return newFlow();
  if (state.view === "time") return editSession(null);
  if (state.view === "admin") return editUser(null);
  openEditor(map[state.view] || "Tasks", null);
}

/* ---------- scope picker ---------- */
function setScope(tag) {
  state.scope = tag || "";
  localStorage.setItem("crm.scope", state.scope);
  state.flowSel = null; state.flowDraft = null;
  paint();
}

function openScopePicker() {
  const rows = [`<button data-s="" class="${!state.scope ? "on" : ""}" style="--c:#8b98a6">Whole org</button>`];
  state.data.departments.forEach(d => {
    rows.push(`<button data-s="${esc(d.dept)}" class="${state.scope === d.dept ? "on" : ""}" style="--c:${esc(d.colour)}">${esc(d.label)}</button>`);
    teamsIn(d.dept).forEach(t => {
      const k = d.dept + "." + t.team;
      rows.push(`<button data-s="${esc(k)}" class="${state.scope === k ? "on" : ""}" style="--c:${esc(t.colour)}">${esc(d.label)} › ${esc(t.label)}</button>`);
    });
  });
  modal({
    title: "Scope",
    body: `<div class="hint" style="margin:0 0 11px">Narrows every view to one department or team. It is a lens — it never shows you anything your postings do not already allow.</div>` +
          `<div class="tagpick" id="scopePick">${rows.join("")}</div>`,
    hideSave: true,
    after: () => {
      $("scopePick").onclick = e => {
        const b = e.target.closest("button[data-s]");
        if (!b) return;
        setScope(b.dataset.s);
        closeModal();
      };
    }
  });
}

/* ============================================================================
   PAINT
   ========================================================================== */
function paint() {
  renderRail();
  renderCrumbs();
  if (state.view === "admin" && state.user.role !== "admin") state.view = "dash";
  document.querySelectorAll(".view").forEach(v => v.classList.remove("on"));
  const v = $("v-" + state.view);
  if (v) v.classList.add("on");
  paintView();
  renderRunBox();
}

function paintView() {
  switch (state.view) {
    case "dash": return renderDash();
    case "tasks": return renderTasks();
    case "flows": return renderFlows();
    case "contacts": return renderContacts();
    case "companies": return renderCompanies();
    case "time": return renderTime();
    case "admin": return renderAdmin();
  }
}

/* ---------- the view bar ---------- */
// bits: {title, count, controls:[html…]} — the controls are wired by the caller
function setBar(title, count, controlsHtml) {
  $("viewBar").innerHTML =
    `<span class="vtitle">${esc(title)}</span>` +
    (count !== null && count !== undefined ? `<span class="vcount">${esc(count)}</span>` : "") +
    (controlsHtml || "");
}
function sel(id, opts, value, extra) {
  return `<select class="fsel" id="${id}"${extra || ""}>` + opts.map(o =>
    `<option value="${esc(o.value)}"${String(o.value) === String(value) ? " selected" : ""}>${esc(o.label)}</option>`
  ).join("") + `</select>`;
}
const peopleOpts = (first) => [{ value: "", label: first || "Anyone" }, { value: "@me", label: "Me" }]
  .concat(state.data.people.map(p => ({ value: p.userId, label: p.name })));
const listOpts = (type, first) => [{ value: "", label: first }]
  .concat((state.data.lists[type] || []).map(o => ({ value: o.value, label: o.label })));

function filt(view, key, dflt) {
  const k = view + "." + key;
  return state.filters[k] === undefined ? (dflt || "") : state.filters[k];
}
function onFilt(view, key, cb) {
  const node = $("f_" + key);
  if (!node) return;
  node.addEventListener("input", () => {
    state.filters[view + "." + key] = node.value;
    (cb || paintView)();
  });
}

/* ---------- the grid ---------- */
function grid(table, cols, rows, opts) {
  opts = opts || {};
  table.innerHTML = "";

  const thead = el("thead"), htr = el("tr");
  htr.appendChild(el("th", "", "#"));
  cols.forEach(c => {
    const th = el("th", c.sort ? "srt" : "");
    if (c.w) th.style.width = c.w;
    const s = state.sort[opts.key] || {};
    th.innerHTML = esc(c.h) + (c.sort && s.key === c.sort ? `<span class="ar">${s.dir < 0 ? "▼" : "▲"}</span>` : "");
    if (c.sort) th.onclick = () => {
      const cur = state.sort[opts.key] || {};
      state.sort[opts.key] = { key: c.sort, dir: cur.key === c.sort ? -(cur.dir || 1) : 1 };
      paintView();
    };
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tb = el("tbody");
  if (!rows.length) {
    const tr = el("tr"), td = el("td");
    td.colSpan = cols.length + 1;
    td.style.borderRight = "none";
    td.innerHTML = `<div class="blank"><div><div class="t">${esc(opts.blankTitle || "Nothing here")}</div>` +
                   `<div class="d">${esc(opts.blank || "")}</div>` +
                   (opts.blankAction || "") + `</div></div>`;
    tr.appendChild(td); tb.appendChild(tr); table.appendChild(tb);
    if (opts.afterBlank) opts.afterBlank();
    return;
  }
  rows.forEach((row, i) => {
    const tr = el("tr", opts.rowClass ? opts.rowClass(row) : "");
    tr.appendChild(el("td", "rownum", String(i + 1)));
    cols.forEach(c => tr.appendChild(el("td", c.cls || "", c.get(row))));
    if (opts.onRow) {
      tr.classList.add("clickable");
      tr.addEventListener("click", e => {
        if (e.target.closest("button,a,select,input")) return;
        opts.onRow(row);
      });
    }
    tb.appendChild(tr);
  });
  table.appendChild(tb);
}

function sortRows(rows, key, fallback) {
  const s = state.sort[key] || {};
  const field = s.key || fallback;
  const dir = s.dir || 1;
  return rows.slice().sort((a, b) => {
    let x = a[field], y = b[field];
    if (typeof x === "number" || typeof y === "number") return ((Number(x) || 0) - (Number(y) || 0)) * dir;
    x = lc(x); y = lc(y);
    if (!x && y) return 1;                     // blanks sink whichever way it points
    if (x && !y) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}
function hits(row, fields) {
  if (!state.q) return true;
  const n = lc(state.q);
  return fields.some(f => lc(row[f]).indexOf(n) >= 0);
}
function editBtn(entity, row) {
  return row._canWrite
    ? `<button class="btn xs" data-edit="${esc(entity)}" data-id="${esc(row.id)}">Edit</button>`
    : `<span class="ro">read only</span>`;
}
function dueClass(iso, done) {
  if (!iso || done) return "";
  return iso < todayIso() ? "late" : iso === todayIso() ? "soon" : "";
}
function statusCount(text) { $("statusCount").textContent = text ? "· " + text : ""; }

/* ============================================================================
   TASKS
   ========================================================================== */
function taskRows() {
  const tag = filt("tasks", "tag");
  const st = filt("tasks", "status", "@open");
  const who = filt("tasks", "who");
  const flow = filt("tasks", "flow");
  return scoped(state.data.tasks).filter(t => {
    if (tag && tagsOf(t.tags).indexOf(tag) < 0) return false;
    if (st === "@open") { if (t.status === "Done") return false; }
    else if (st === "@late") { if (t.status === "Done" || !t.dueDate || t.dueDate >= todayIso()) return false; }
    else if (st && t.status !== st) return false;
    if (who === "@me") { if (lc(t.assignee) !== lc(state.user.userId)) return false; }
    else if (who && lc(t.assignee) !== lc(who)) return false;
    if (flow === "@none") { if (t.flowId) return false; }
    else if (flow && t.flowId !== flow) return false;
    return hits(t, ["title", "notes", "status", "priority"]);
  });
}

function taskMinutes(taskId) {
  let m = 0;
  state.data.time.forEach(t => { if (t.taskId === taskId) m += (t.minutes || 0); });
  if (state.running && state.running.taskId === taskId) m += liveMinutes();
  return m;
}

function renderTasks() {
  const flows = usableFlows();
  const mode = state.mode.tasks;
  setBar("Tasks", null,
    sel("f_status", [{ value: "@open", label: "Open" }, { value: "@late", label: "Overdue" }, { value: "", label: "Any status" }]
      .concat((state.data.lists.taskStatus || []).map(s => ({ value: s.value, label: s.label }))), filt("tasks", "status", "@open")) +
    sel("f_who", peopleOpts("Anyone"), filt("tasks", "who")) +
    sel("f_flow", [{ value: "", label: "Any flow" }, { value: "@none", label: "No flow" }]
      .concat(flows.map(f => ({ value: f.id, label: f.name }))), filt("tasks", "flow")) +
    (state.scope ? "" : sel("f_tag", [{ value: "", label: "Any client" }]
      .concat(state.data.tags.map(t => ({ value: t.tag, label: t.label }))), filt("tasks", "tag"))) +
    `<span class="spacer"></span>` +
    `<div class="seg" id="taskMode">
       <button data-m="grid" class="${mode === "grid" ? "on" : ""}">Grid</button>
       <button data-m="board" class="${mode === "board" ? "on" : ""}">Board</button>
     </div>`);
  ["status", "who", "flow", "tag"].forEach(k => onFilt("tasks", k));
  $("taskMode").onclick = e => {
    const b = e.target.closest("button[data-m]"); if (!b) return;
    state.mode.tasks = b.dataset.m; renderTasks();
  };

  const rows = taskRows();
  $("taskGridWrap").style.display = mode === "grid" ? "block" : "none";
  $("taskBoard").style.display = mode === "board" ? "flex" : "none";
  if (mode === "board") renderTaskBoard(rows); else renderTaskGrid(rows);

  const open = rows.filter(r => r.status !== "Done").length;
  statusCount(`${rows.length} tasks · ${open} open · ${fmtMins(rows.reduce((s, r) => s + taskMinutes(r.id), 0))} logged`);
}

function renderTaskGrid(rows) {
  rows = sortRows(rows, "tasks", "dueDate");
  const cols = [
    { h: "Task", cls: "wrap", sort: "title", get: r => {
        const link = linkLabel(r);
        return `<div class="prime">${esc(r.title)}</div>` +
               (link ? `<div class="sub">${esc(link)}</div>` : "");
      } },
    { h: "Flow / stage", sort: "flowId", get: r => stageHtml(r) },
    { h: "Status", sort: "status", get: r => pillHtml("taskStatus", r.status) },
    { h: "Priority", sort: "priority", get: r => pillHtml("priority", r.priority) },
    { h: "Due", sort: "dueDate", get: r =>
        `<span class="${dueClass(r.dueDate, r.status === "Done")}">${esc(fmtDay(r.dueDate)) || "—"}</span>` },
    { h: "Assignee", sort: "assignee", get: r => whoHtml(r.assignee) },
    { h: "Belongs to", cls: "nw", get: r => scopeHtml(r.dept, r.team) },
    { h: "Client", get: r => tagsHtml(r.tags) },
    { h: "Logged", cls: "num", get: r => fmtMins(taskMinutes(r.id)) },
    { h: "Chat", cls: "num", get: r => {
        const n = state.msgCounts[r.id] || 0;
        return n ? `<span class="msgcount">● ${n}</span>` : '<span class="ro">—</span>';
      } },
    { h: "", cls: "act", get: r => {
        const live = state.running && state.running.taskId === r.id;
        const mine = r._canWrite || lc(r.assignee) === lc(state.user.userId);
        return `<span class="rowacts">` +
          (mine ? `<button class="btn xs" data-timer="${esc(r.id)}">${live ? "■ Stop" : "▶ Start"}</button>` : "") +
          editBtn("Tasks", r) + `</span>`;
      } }
  ];
  grid($("gTasks"), cols, rows, {
    key: "tasks",
    blankTitle: state.data.tasks.length ? "Nothing matches" : "No tasks yet",
    blank: state.data.tasks.length
      ? "Try widening the filters, or clearing the scope in the sidebar."
      : "You only see tasks you raised, are watching, or are holding. Create one with + New, put it on a flow, and forward it to the next desk.",
    rowClass: r => (state.running && state.running.taskId === r.id) ? "live" : "",
    onRow: r => openDrawer("Tasks", r.id)
  });
}

// Board columns are a flow's stages when one flow is selected, otherwise statuses.
function renderTaskBoard(rows) {
  const flowId = filt("tasks", "flow");
  const flow = flowId && flowId !== "@none" ? flowOf(flowId) : null;
  const wrap = $("taskBoard");
  wrap.innerHTML = "";

  const cols = flow
    ? flowStages(flow).map(s => ({ key: s.key, label: s.name, colour: s.colour, stage: true }))
    : (state.data.lists.taskStatus || []).map(s => ({ key: s.value, label: s.label, colour: s.colour }));

  if (flow && !cols.length) {
    wrap.innerHTML = `<div class="blank"><div><div class="t">That flow has no stages yet</div>` +
      `<div class="d">Open it in Flows and add a few.</div></div></div>`;
    return;
  }

  cols.forEach(c => {
    const mine = rows.filter(t => flow ? t.stage === c.key : lc(t.status) === lc(c.key));
    const col = el("div", "bcol");
    col.appendChild(el("div", "bchead",
      `<span class="pill" style="--c:${esc(c.colour)}"><span class="dot"></span>${esc(c.label)}</span>` +
      `<span class="spacer"></span><span class="bs">${mine.length}</span>`));
    const body = el("div", "bcbody");
    if (!mine.length) body.appendChild(el("div", "bempty", "—"));
    mine.forEach(t => {
      const card = el("div", "bcard");
      card.draggable = !!t._canWrite;
      const late = flow ? stageOverdue(t, stageOf(flow, t.stage)) : 0;
      card.innerHTML = `<div class="bt">${esc(t.title)}</div><div class="bm">` +
        (t.priority ? pillHtml("priority", t.priority) : "") +
        (t.dueDate ? `<span class="${dueClass(t.dueDate, t.status === "Done")}">${esc(fmtDay(t.dueDate))}</span>` : "") +
        (t.assignee ? whoHtml(t.assignee) : "") +
        (late ? `<span class="late">${esc(fmtAge(late))} over</span>` : "") +
        `</div>`;
      card.onclick = () => openDrawer("Tasks", t.id);
      card.addEventListener("dragstart", ev => { ev.dataTransfer.setData("text/plain", t.id); card.classList.add("drag"); });
      card.addEventListener("dragend", () => card.classList.remove("drag"));
      body.appendChild(card);
    });
    col.appendChild(body);

    col.addEventListener("dragover", ev => { ev.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", async ev => {
      ev.preventDefault(); col.classList.remove("over");
      const id = ev.dataTransfer.getData("text/plain");
      const t = taskOf(id);
      if (!t) return;
      if (flow) { if (t.stage !== c.key) await forward(id, c.key); }
      else if (lc(t.status) !== lc(c.key)) await patch("Tasks", t, { status: c.key });
    });
    wrap.appendChild(col);
  });
}

/* a small single-field save that puts the row back if the sheet refuses */
async function patch(entity, row, changes) {
  const was = {};
  Object.keys(changes).forEach(k => { was[k] = row[k]; });
  Object.assign(row, changes);
  paintView();
  try {
    const r = await API.save(entity, Object.assign({ id: row.id }, changes));
    Object.assign(row, r.record);
    toast("Saved", "ok");
  } catch (err) {
    Object.assign(row, was);
    toast(err.message, "err");
  }
  paint();
}

/* ============================================================================
   FLOWS — the builder
   ========================================================================== */
const STAGE_COLOURS = ["#8b98a6", "#60a5fa", "#a78bfa", "#fbbf24", "#34d399", "#f87171", "#2dd4bf", "#f472b6"];

function renderFlows() {
  const flows = state.data.flows.filter(inScope);
  setBar("Flows", `${flows.length} in scope`,
    `<span class="spacer"></span><button class="btn sm" id="btnNewFlow">+ Flow</button>`);
  $("btnNewFlow").onclick = newFlow;

  // list
  const list = $("flowList");
  list.innerHTML = `<div class="fhead"><h4>Flows</h4></div>`;
  if (!flows.length) {
    list.insertAdjacentHTML("beforeend",
      `<div style="padding:18px 14px;font-size:12px;color:var(--ink-faint);line-height:1.6">` +
      `No flows in this scope yet. A flow is the path a task takes — brief, building, review, delivered — ` +
      `with a time target on each step.</div>`);
  }
  flows.forEach(f => {
    const b = el("button", "fitem" + (state.flowSel === f.id ? " on" : "") + (f.active === false ? " off" : ""));
    const n = state.data.tasks.filter(t => t.flowId === f.id).length;
    b.innerHTML = `<div class="fn">${esc(f.name)}</div><div class="fm">` +
      `<span>${flowStages(f).length} stages</span><span>·</span><span>${n} task${n === 1 ? "" : "s"}</span>` +
      (f.dept ? ` ${scopeHtml(f.dept, f.team)}` : "") + `</div>`;
    b.onclick = () => selectFlow(f.id);
    list.appendChild(b);
  });

  if (!state.flowSel || !flowOf(state.flowSel)) state.flowSel = flows.length ? flows[0].id : null;
  if (state.flowSel && (!state.flowDraft || state.flowDraft.id !== state.flowSel)) loadDraft(state.flowSel);
  renderCanvas();
  statusCount(`${flows.length} flow${flows.length === 1 ? "" : "s"}`);
}

function selectFlow(id) {
  if (state.flowDraft && dirty() && !confirm("Discard the unsaved changes to this flow?")) return;
  state.flowSel = id;
  loadDraft(id);
  renderFlows();
}

function loadDraft(id) {
  const f = flowOf(id);
  if (!f) { state.flowDraft = null; return; }
  state.flowDraft = JSON.parse(JSON.stringify({
    id: f.id, name: f.name, dept: f.dept || "", team: f.team || "", description: f.description,
    active: f.active !== false, stages: flowStages(f), _canWrite: f._canWrite
  }));
}
function dirty() {
  const f = flowOf(state.flowSel);
  if (!f || !state.flowDraft) return false;
  const shape = x => JSON.stringify({
    n: x.name, dp: lc(x.dept), tm: lc(x.team), d: x.description,
    a: x.active !== false, s: x.stages || flowStages(x)
  });
  return shape(f) !== shape(state.flowDraft);
}

function newFlow() {
  const mine = myWritableScopes();
  if (!mine.length) { toast("You need a posting you can write to before you can own a flow.", "err"); return; }
  const depts = state.data.departments.filter(d => state.user.all || mine.some(m => m.dept === d.dept));
  if (!depts.length) { toast("No department you can write to.", "err"); return; }

  const draft = { dept: depts[0].dept, team: "" };
  const paintScope = () => {
    const teams = teamsIn(draft.dept);
    $("nfScope").innerHTML =
      `<select class="inp" id="nfDept">` + depts.map(d =>
        `<option value="${esc(d.dept)}"${d.dept === draft.dept ? " selected" : ""}>${esc(d.label)}</option>`).join("") + `</select>` +
      (teams.length ? `<select class="inp" id="nfTeam"><option value="">Whole department</option>` +
        teams.map(t => `<option value="${esc(t.team)}"${t.team === draft.team ? " selected" : ""}>${esc(t.label)}</option>`).join("") +
        `</select>` : "");
    $("nfDept").addEventListener("input", e => { draft.dept = e.target.value; draft.team = ""; paintScope(); });
    const t = $("nfTeam"); if (t) t.addEventListener("input", e => { draft.team = e.target.value; });
  };

  modal({
    title: "New flow",
    body: `<div class="field"><label>Name</label><input class="inp" id="nfName" placeholder="CRO request"></div>` +
          `<div class="field"><label>Belongs to</label><div class="scopefield" id="nfScope"></div>` +
          `<div class="hint">The department this flow serves. Only people posted there will see it.</div></div>` +
          `<div class="field"><label>Start from</label>` +
          sel("nfTemplate", [
            { value: "standard", label: "A five-desk flow for this department (you can edit it)" },
            { value: "blank", label: "Blank — I'll build the steps myself" }
          ], "standard") + `</div>`,
    after: () => {
      paintScope();
      $("nfName").focus();
      modalSave(async () => {
        const name = $("nfName").value.trim();
        if (!name) throw new Error("Give the flow a name.");

        // address the template's desks to positions that actually exist
        const has = k => state.data.positions.some(p => p.position === k);
        const at = (team, pos) => has(pos) ? [draft.dept + (team ? "." + team : "") + "." + pos] : [];
        const teams = teamsIn(draft.dept).map(t => t.team);
        const doers = teams.length
          ? teams.reduce((acc, t) => acc.concat(at(t, "tl"), at(t, "member")), [])
          : at("", "member");

        const stages = $("nfTemplate").value === "blank" ? [
          { key: "step-1", name: "Raised", colour: STAGE_COLOURS[1], to: [], next: [],
            slaHours: 4, entry: true, approval: false, terminal: false }
        ] : [
          { key: "raised", name: "Raised",    colour: "#60a5fa", to: at("", "member"), next: ["triage"], slaHours: 4, entry: true },
          { key: "triage", name: "Triage",    colour: "#2dd4bf", to: at("", "manager"), next: ["work", "review"], slaHours: 8 },
          { key: "work",   name: "In hand",   colour: "#fbbf24", to: doers, next: ["review"], slaHours: 48 },
          { key: "review", name: "Review",    colour: "#a78bfa", to: at("", "manager"), next: ["work", "done"], slaHours: 12, approval: true },
          { key: "done",   name: "Delivered", colour: "#34d399", to: [], next: [], slaHours: 0, terminal: true }
        ];

        const r = await API.save("Flows", {
          name, dept: draft.dept, team: draft.team, tags: "", description: "", active: true, stages
        });
        state.data.flows.push(r.record);
        state.flowSel = r.record.id;
        loadDraft(r.record.id);
        closeModal();
        go("flows");
        toast("Flow created", "ok");
      });
    }
  });
}

function renderCanvas() {
  const c = $("flowCanvas");
  const d = state.flowDraft;
  if (!d) {
    c.innerHTML = `<div class="blank"><div><div class="t">No flow selected</div>` +
      `<div class="d">Pick one on the left, or build a new one. A flow describes how a task travels: ` +
      `the stages it passes through, who owns each, and how long each should take.</div></div></div>`;
    return;
  }
  const ro = !d._canWrite;

  c.innerHTML =
    `<div class="cvhead">
       <div style="flex:1;min-width:240px">
         <input class="cvname" id="fName" value="${esc(d.name)}" ${ro ? "disabled" : ""}>
         <textarea class="cvdesc" id="fDesc" rows="1" placeholder="What this flow is for" ${ro ? "disabled" : ""}>${esc(d.description || "")}</textarea>
       </div>
       <div style="display:flex;gap:8px;align-items:center">
         ${ro ? '<span class="ro">read only</span>' : ""}
         <button class="btn sm" id="fActive">${d.active ? "Active" : "Paused"}</button>
         <button class="btn danger sm" id="fDelete" ${ro ? "disabled" : ""}>Delete</button>
         <button class="btn pri sm" id="fSave" ${ro ? "disabled" : ""}>Save flow</button>
       </div>
     </div>
     <div class="cvmeta">
       <div><div class="mk">Belongs to</div><div class="scopefield" id="fScope"></div></div>
       <div><div class="mk">On this flow</div><div style="font-size:12.5px">${
         state.data.tasks.filter(t => t.flowId === d.id).length} task(s)</div></div>
     </div>
     <div class="mk" style="font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:10px">Flowchart</div>
     <div class="chain" id="fChain"></div>`;

  paintFlowTags();
  paintChain();

  if (!ro) {
    $("fName").addEventListener("input", e => { d.name = e.target.value; });
    $("fDesc").addEventListener("input", e => { d.description = e.target.value; });
    $("fActive").onclick = () => { d.active = !d.active; renderCanvas(); };
    $("fSave").onclick = saveFlow;
    $("fDelete").onclick = deleteFlow;
  }
}

function paintFlowTags() {
  const d = state.flowDraft;
  const box = $("fScope");
  if (!box) return;
  const ro = !d._canWrite;
  const teams = teamsIn(d.dept);
  box.innerHTML =
    `<select class="inp" id="fDept" ${ro ? "disabled" : ""}>` +
      `<option value="">— unassigned —</option>` +
      state.data.departments.map(x =>
        `<option value="${esc(x.dept)}"${lc(d.dept) === x.dept ? " selected" : ""}>${esc(x.label)}</option>`).join("") +
    `</select>` +
    (teams.length ? `<select class="inp" id="fTeam" ${ro ? "disabled" : ""}>` +
      `<option value="">Whole department</option>` +
      teams.map(t => `<option value="${esc(t.team)}"${lc(d.team) === t.team ? " selected" : ""}>${esc(t.label)}</option>`).join("") +
      `</select>` : "");
  if (ro) return;
  $("fDept").addEventListener("input", e => { d.dept = e.target.value; d.team = ""; paintFlowTags(); });
  const t = $("fTeam");
  if (t) t.addEventListener("input", e => { d.team = e.target.value; });
}

/* ---------- the flowchart ----------
   Columns come from the shortest path out of an entry step, so the chart
   reads left to right and a step that sends work back simply draws a curve
   returning to an earlier column. Nothing is hand-positioned. */
const NODE_W = 200, NODE_H = 96, GAP_X = 66, GAP_Y = 26;

function outsOf(stages, s) {
  if (s.next && s.next.length) return s.next;
  const i = stages.indexOf(s);
  return stages[i + 1] ? [stages[i + 1].key] : [];
}

function layoutFlow(stages) {
  const byKey = {};
  stages.forEach(s => { byKey[s.key] = s; });
  const entries = stages.filter(s => s.entry);
  const roots = (entries.length ? entries : stages.slice(0, 1)).map(s => s.key);

  const layer = {}, queue = roots.slice();
  roots.forEach(k => { layer[k] = 0; });
  while (queue.length) {
    const k = queue.shift();
    const s = byKey[k];
    if (!s) continue;
    outsOf(stages, s).forEach(n => {
      if (!byKey[n] || layer[n] !== undefined) return;
      layer[n] = layer[k] + 1;
      queue.push(n);
    });
  }
  // a step nothing routes to still has to go somewhere
  let maxL = 0;
  Object.keys(layer).forEach(k => { maxL = Math.max(maxL, layer[k]); });
  stages.forEach(s => { if (layer[s.key] === undefined) layer[s.key] = maxL + 1; });

  const cols = [];
  stages.forEach(s => {
    const l = layer[s.key];
    (cols[l] = cols[l] || []).push(s);
  });

  const pos = {};
  cols.forEach((col, ci) => {
    (col || []).forEach((s, ri) => {
      pos[s.key] = { x: ci * (NODE_W + GAP_X), y: ri * (NODE_H + GAP_Y), col: ci, row: ri };
    });
  });
  const rows = cols.reduce((m, c) => Math.max(m, (c || []).length), 0);
  return {
    pos, cols,
    width: Math.max(1, cols.length) * (NODE_W + GAP_X) - GAP_X,
    height: Math.max(1, rows) * (NODE_H + GAP_Y) - GAP_Y
  };
}

function edgePath(a, b) {
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
  const x2 = b.x,          y2 = b.y + NODE_H / 2;
  if (x2 >= x1) {                                  // forward: a flat S-curve
    const dx = Math.max(28, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  // sending work back: drop under the row and come up into the left edge
  const ax = a.x + NODE_W / 2, bx = b.x + NODE_W / 2;
  const under = Math.max(a.y, b.y) + NODE_H + 16;
  return `M ${ax} ${a.y + NODE_H} C ${ax} ${under}, ${bx} ${under}, ${bx} ${b.y + NODE_H}`;
}

function paintChain() {
  const d = state.flowDraft;
  const host = $("fChain");
  if (!host) return;
  const ro = !d._canWrite;
  host.innerHTML = "";

  if (!d.stages.length) {
    host.innerHTML = `<div class="ro">No steps yet.</div>`;
    if (!ro) {
      const add = el("button", "btn sm", "+ Step");
      add.style.marginTop = "10px";
      add.onclick = () => addStage(0);
      host.appendChild(add);
    }
    return;
  }

  const L = layoutFlow(d.stages);
  const chart = el("div", "chart");
  chart.style.width = L.width + "px";
  chart.style.height = (L.height + 40) + "px";

  // edges first, so the nodes sit on top of them
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "edges");
  svg.setAttribute("width", L.width);
  svg.setAttribute("height", L.height + 40);
  svg.innerHTML =
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7"
       orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker></defs>`;
  d.stages.forEach(s => {
    const a = L.pos[s.key];
    outsOf(d.stages, s).forEach(k => {
      const b = L.pos[k];
      if (!a || !b) return;
      const back = b.x < a.x + NODE_W;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", edgePath(a, b));
      p.setAttribute("class", "edge" + (back ? " back" : ""));
      p.setAttribute("marker-end", "url(#arrow)");
      svg.appendChild(p);
    });
  });
  chart.appendChild(svg);

  d.stages.forEach((s, i) => {
    const p = L.pos[s.key];
    const node = el("div", "node" + (state.stepSel === s.key ? " sel" : ""));
    node.style.cssText = `left:${p.x}px;top:${p.y}px;width:${NODE_W}px;--c:${s.colour}`;

    // the departments this step sits with, drawn as blocks
    const seen = {}, blocks = [];
    (s.to || []).forEach(t => {
      const q = parsePosting(t);
      if (!q) return;
      const key = q.dept + "/" + (q.team || "");
      if (seen[key]) return;
      seen[key] = 1;
      const dm = deptMeta(q.dept);
      blocks.push(`<span class="deptblock" style="--c:${esc(dm.colour)}">${esc(dm.label)}` +
        (q.team ? `<i>${esc(teamMeta(q.team).label)}</i>` : "") + `</span>`);
    });

    const here = state.data.tasks.filter(t => t.flowId === d.id && t.stage === s.key).length;
    node.innerHTML =
      `<div class="nhead"><span class="nstep">${i + 1}</span><span class="nname">${esc(s.name)}</span></div>` +
      `<div class="nblocks">${blocks.join("") || '<span class="ro">no desk</span>'}</div>` +
      `<div class="nfoot">` +
        (s.entry ? `<span class="nflag in">in</span>` : "") +
        (s.approval ? `<span class="nflag ap">approval</span>` : "") +
        (s.terminal ? `<span class="nflag fin">final</span>` : "") +
        (s.slaHours ? `<span class="ls">${s.slaHours}h</span>` : "") +
        `<span class="spacer"></span>` +
        (here ? `<span class="nhere">${here}</span>` : "") +
      `</div>`;
    node.onclick = () => {
      state.stepSel = state.stepSel === s.key ? null : s.key;
      paintChain();
    };
    chart.appendChild(node);
  });

  const wrap = el("div", "chartwrap");
  wrap.appendChild(chart);
  host.appendChild(wrap);

  if (!ro) {
    const bar = el("div", "chartbar");
    const add = el("button", "btn sm", "+ Step");
    add.onclick = () => addStage(d.stages.length);
    bar.appendChild(add);
    bar.appendChild(el("span", "hint", "Click a step to edit it. Arrows show where work can be sent; a curve underneath is work going back."));
    host.appendChild(bar);
  }

  // the selected step's editor, under the chart
  const sel = d.stages.findIndex(s => s.key === state.stepSel);
  if (sel >= 0) host.appendChild(stageNode(d.stages[sel], sel, ro));
}

/* The editor for one step, shown under the chart when a node is picked.
   Position in the chart comes from the routing, so there is nothing to drag. */
function stageNode(s, i, ro) {
  const d = state.flowDraft;
  const card = el("div", "stagecard open");
  card.style.setProperty("--c", s.colour);

  const others = d.stages.filter(o => o !== s);
  const goesTo = (s.next && s.next.length) ? s.next
    : (d.stages[i + 1] ? [d.stages[i + 1].key] : []);

  card.innerHTML =
    `<div class="sidx"><span class="grip">${ro ? "" : "☰"}</span><span>STEP ${i + 1}</span>` +
    `<span class="spacer" style="flex:1"></span>` +
    (ro ? "" : `<button class="btn xs" data-up ${i === 0 ? "disabled" : ""}>←</button>` +
               `<button class="btn xs" data-down ${i === d.stages.length - 1 ? "disabled" : ""}>→</button>`) +
    `</div>` +
    `<input class="sname" value="${esc(s.name)}" ${ro ? "disabled" : ""}>` +

    `<div class="sgroup"><div class="sgl">Handled by</div>` +
      `<div class="targets" data-to>` +
        ((s.to || []).length
          ? (s.to || []).map(t => `<span class="target">${postingHtml(parsePosting(t)) || esc(t)}` +
              (ro ? "" : `<button class="x" data-rm="${esc(t)}" title="Remove">×</button>`) + `</span>`).join("")
          : '<span class="ro">nobody yet</span>') +
      `</div>` +
      (ro ? "" : `<button class="btn xs" data-addto style="margin-top:6px">+ Desk</button>`) +
    `</div>` +

    `<div class="sgroup"><div class="sgl">Can be sent to</div><div class="tagpick tiny" data-next>` +
      (others.length ? others.map(o => {
        const on = goesTo.indexOf(o.key) >= 0;
        return `<button data-n="${esc(o.key)}" class="${on ? "on" : ""}" style="--c:${esc(o.colour)}" ${ro ? "disabled" : ""}>${esc(o.name)}</button>`;
      }).join("") : '<span class="ro">no other steps</span>') +
    `</div></div>` +

    `<div class="srow"><label>Target</label><input class="inp" type="number" min="0" step="1" value="${esc(s.slaHours || 0)}" data-sla ${ro ? "disabled" : ""}><label>h</label></div>` +
    `<div class="swatches">` + STAGE_COLOURS.map(col =>
        `<button class="swatch${col === s.colour ? " on" : ""}" style="background:${col}" data-col="${col}" ${ro ? "disabled" : ""}></button>`).join("") + `</div>` +
    `<div class="sflags">` +
      `<button class="flag${s.entry ? " on" : ""}" data-flag="entry" ${ro ? "disabled" : ""}>Work comes in here</button>` +
      `<button class="flag${s.approval ? " on" : ""}" data-flag="approval" ${ro ? "disabled" : ""}>Approval</button>` +
      `<button class="flag${s.terminal ? " on" : ""}" data-flag="terminal" ${ro ? "disabled" : ""}>Final</button>` +
    `</div>` +
    (ro ? "" : `<div class="stagefoot"><button class="btn danger xs" data-del style="flex:1">Remove</button></div>`);

  if (ro) return card;

  card.querySelector(".sname").addEventListener("input", e => {
    s.name = e.target.value;
    if (!s._keyLocked) {
      const old = s.key;
      s.key = slug(e.target.value) || s.key;
      // keep everyone pointing at it after a rename
      d.stages.forEach(o => {
        if (o.next) o.next = o.next.map(k => (k === old ? s.key : k));
      });
    }
  });
  card.querySelector("[data-sla]").addEventListener("input", e => { s.slaHours = Math.max(0, Number(e.target.value) || 0); });
  card.querySelector("[data-to]").onclick = e => {
    const x = e.target.closest("button[data-rm]"); if (!x) return;
    s.to = (s.to || []).filter(t => t !== x.dataset.rm);
    paintChain();
  };
  card.querySelector("[data-addto]").onclick = () => addDesk(s);
  card.querySelector("[data-next]").onclick = e => {
    const b = e.target.closest("button[data-n]"); if (!b) return;
    const list = goesTo.slice();
    const at = list.indexOf(b.dataset.n);
    if (at >= 0) list.splice(at, 1); else list.push(b.dataset.n);
    s.next = list;
    paintChain();
  };
  card.querySelectorAll(".swatch").forEach(b => b.onclick = () => { s.colour = b.dataset.col; paintChain(); });
  card.querySelectorAll(".flag").forEach(b => b.onclick = () => {
    const f = b.dataset.flag;
    s[f] = !s[f];
    // only one step can be the end of the line
    if (f === "terminal" && s.terminal) {
      d.stages.forEach(o => { if (o !== s) o.terminal = false; });
      s.next = [];
    }
    paintChain();
  });
  card.querySelector("[data-del]").onclick = () => {
    if (d.stages.length === 1) { toast("A flow needs at least one stage.", "err"); return; }
    const used = state.data.tasks.filter(t => t.flowId === d.id && t.stage === s.key).length;
    if (used && !confirm(`${used} task(s) are sitting in "${s.name}". Remove it anyway? They will show as not started.`)) return;
    d.stages.splice(i, 1);
    paintChain();
  };
  card.querySelector("[data-up]").onclick = () => move(i, i - 1);
  card.querySelector("[data-down]").onclick = () => move(i, i + 1);

  return card;
}

/* Add a desk to a step: a department, optionally a team, and a position.
   That triple is the posting the step is addressed to. */
function addDesk(step) {
  const depts = state.data.departments;
  if (!depts.length) { toast("Add a department in Admin first.", "err"); return; }
  const positions = state.data.positions;
  if (!positions.length) { toast("Add a position in Admin first.", "err"); return; }

  const draft = { dept: depts[0].dept, team: "", position: positions[0].position };
  const paint = () => {
    const teams = teamsIn(draft.dept);
    $("adBody").innerHTML =
      `<div class="frow">` +
        `<div class="field"><label>Department</label><select class="inp" id="adDept">` +
          depts.map(d => `<option value="${esc(d.dept)}"${d.dept === draft.dept ? " selected" : ""}>${esc(d.label)}</option>`).join("") +
        `</select></div>` +
        `<div class="field"><label>Team</label><select class="inp" id="adTeam"${teams.length ? "" : " disabled"}>` +
          `<option value="">Whole department</option>` +
          teams.map(t => `<option value="${esc(t.team)}"${t.team === draft.team ? " selected" : ""}>${esc(t.label)}</option>`).join("") +
        `</select></div>` +
        `<div class="field"><label>Position</label><select class="inp" id="adPos">` +
          positions.map(p => `<option value="${esc(p.position)}"${p.position === draft.position ? " selected" : ""}>${esc(p.label)}</option>`).join("") +
        `</select></div>` +
      `</div>` +
      `<div class="hint">This step will be handed to <b>${esc(postingText(draft))}</b> — ` +
      `${staffForStep({ to: [postingText(draft)] }).map(p => esc(p.name)).join(", ") || "nobody holds that posting yet"}.` +
      `<br>Leaving the team as "whole department" matches that position in any team.</div>`;
    $("adDept").addEventListener("input", e => { draft.dept = e.target.value; draft.team = ""; paint(); });
    const t = $("adTeam"); if (t) t.addEventListener("input", e => { draft.team = e.target.value; paint(); });
    $("adPos").addEventListener("input", e => { draft.position = e.target.value; paint(); });
  };

  modal({
    title: "Who handles this step",
    saveLabel: "Add",
    body: `<div id="adBody"></div>`,
    after: () => {
      paint();
      modalSave(async () => {
        const key = postingText(draft);
        step.to = step.to || [];
        if (step.to.indexOf(key) < 0) step.to.push(key);
        closeModal();
        paintChain();
      });
    }
  });
}

function move(from, to) {
  const d = state.flowDraft;
  if (to < 0 || to >= d.stages.length || from === to) return;
  const [s] = d.stages.splice(from, 1);
  d.stages.splice(to, 0, s);
  paintChain();
}

function addStage(at) {
  const d = state.flowDraft;
  const n = d.stages.length + 1;
  const stage = {
    key: "step-" + Date.now().toString(36).slice(-4),
    name: "Step " + n, colour: STAGE_COLOURS[(n - 1) % STAGE_COLOURS.length],
    to: [], next: [], slaHours: 24, entry: false, approval: false, terminal: false
  };
  d.stages.splice(at, 0, stage);
  state.stepSel = stage.key;      // open the new step straight away
  paintChain();
}

async function saveFlow() {
  const d = state.flowDraft;
  if (!d.name.trim()) { toast("Give the flow a name.", "err"); return; }
  if (!d.stages.length) { toast("A flow needs at least one stage.", "err"); return; }

  // keys must be unique, or a task could not say which desk it is at; remap
  // every route as we go so renaming never leaves a step pointing at nothing
  const seen = {}, rename = {};
  d.stages.forEach((s, i) => {
    let k = slug(s.key || s.name) || ("step-" + (i + 1));
    while (seen[k]) k = k + "-" + (i + 1);
    seen[k] = true;
    if (s.key && s.key !== k) rename[s.key] = k;
    s.key = k; s._keyLocked = true;
    s.name = s.name.trim() || ("Step " + (i + 1));
  });
  d.stages.forEach(s => {
    s.next = (s.next || []).map(k => rename[k] || k).filter(k => seen[k] && k !== s.key);
    if (s.terminal) s.next = [];
  });
  if (!d.stages.some(s => s.entry)) d.stages[0].entry = true;   // work has to come in somewhere

  $("fSave").disabled = true;
  try {
    const r = await API.save("Flows", {
      id: d.id, name: d.name.trim(), dept: d.dept, team: d.team, description: d.description,
      active: d.active, stages: d.stages.map(s => ({
        key: s.key, name: s.name, colour: s.colour, slaHours: s.slaHours,
        to: s.to || [], next: s.next || [],
        entry: !!s.entry, approval: !!s.approval, terminal: !!s.terminal
      }))
    });
    const i = state.data.flows.findIndex(f => f.id === r.record.id);
    if (i >= 0) state.data.flows[i] = r.record; else state.data.flows.push(r.record);
    loadDraft(r.record.id);
    toast("Flow saved", "ok");
    renderFlows();
  } catch (err) { toast(err.message, "err"); }
  finally { const b = $("fSave"); if (b) b.disabled = false; }
}

async function deleteFlow() {
  const d = state.flowDraft;
  const used = state.data.tasks.filter(t => t.flowId === d.id).length;
  if (!confirm(used
    ? `${used} task(s) are on "${d.name}". Delete the flow anyway? Those tasks keep their stage but lose the path.`
    : `Delete the flow "${d.name}"?`)) return;
  try {
    await API.remove("Flows", d.id);
    const i = state.data.flows.findIndex(f => f.id === d.id);
    if (i >= 0) state.data.flows.splice(i, 1);
    state.flowSel = null; state.flowDraft = null;
    toast("Flow deleted", "ok");
    renderFlows();
  } catch (err) { toast(err.message, "err"); }
}

/* ---------- forwarding a task to the next desk ---------- */
// `assignee` may be left out: the backend takes it when a step has exactly one
// wearer, and asks (code "pick") when there is a choice to make.
async function forward(taskId, stepKey, assignee, note) {
  try {
    const r = await API.forward(taskId, stepKey, assignee || "", note || "");
    const i = state.data.tasks.findIndex(t => t.id === taskId);
    if (i >= 0) state.data.tasks[i] = r.task; else state.data.tasks.push(r.task);
    if (r.closed) {
      const j = state.data.flowlog.findIndex(l => l.id === r.closed.id);
      if (j >= 0) state.data.flowlog[j] = r.closed;
    }
    if (r.opened) state.data.flowlog.push(r.opened);
    const f = flowOf(r.task.flowId);
    const s = f && stageOf(f, r.task.stage);
    toast(`Sent to ${s ? s.name : "the next step"}` +
          (r.task.assignee ? " · " + personName(r.task.assignee) : ""), "ok");
    paint();
    if ($("drawer").classList.contains("on")) openDrawer("Tasks", taskId);
    return true;
  } catch (err) {
    if (err.code === "pick") { pickHandover(taskId, stepKey); return false; }
    toast(err.message, "err");
    return false;
  }
}

// more than one person wears the badge for that step — ask who takes it
function pickHandover(taskId, stepKey) {
  const t = taskOf(taskId);
  const f = flowOf(t && t.flowId);
  const step = f && stageOf(f, stepKey);
  if (!step) return;
  const pool = staffForStep(step);

  modal({
    title: "Hand over to " + step.name,
    saveLabel: "Send",
    body:
      `<div class="field"><label>Who takes it on</label><select class="inp" id="hoWho">` +
      pool.map(p => `<option value="${esc(p.userId)}">${esc(p.name)}</option>`).join("") +
      `</select><div class="hint">${desksHtml(step.to)} — only people holding one of these can be handed the step.</div></div>` +
      `<div class="field"><label>Note (optional)</label><input class="inp" id="hoNote" placeholder="What they need to know"></div>`,
    after: () => modalSave(async () => {
      const who = $("hoWho").value;
      const ok = await forward(taskId, stepKey, who, $("hoNote").value.trim());
      if (ok) closeModal();
    })
  });
}


/* ============================================================================
   CONTACTS / COMPANIES
   ========================================================================== */
function renderContacts() {
  setBar("Contacts", null,
    sel("f_status", listOpts("contactStatus", "Any status"), filt("contacts", "status")) +
    (state.scope ? "" : sel("f_tag", [{ value: "", label: "Any client" }]
      .concat(state.data.tags.map(t => ({ value: t.tag, label: t.label }))), filt("contacts", "tag"))));
  ["status", "tag"].forEach(k => onFilt("contacts", k));

  const st = filt("contacts", "status"), tag = filt("contacts", "tag");
  let rows = scoped(state.data.contacts).filter(c => {
    if (tag && tagsOf(c.tags).indexOf(tag) < 0) return false;
    if (st && c.status !== st) return false;
    const co = company(c.companyId);
    return hits(c, ["name", "email", "phone", "title", "notes"]) ||
           (!!state.q && !!co && lc(co.name).indexOf(lc(state.q)) >= 0);
  });
  rows = sortRows(rows, "contacts", "name");

  grid($("gContacts"), [
    { h: "Name", cls: "wrap", sort: "name", get: r =>
        `<div class="prime">${esc(r.name)}</div>` + (r.title ? `<div class="sub">${esc(r.title)}</div>` : "") },
    { h: "Company", sort: "companyId", get: r => { const c = company(r.companyId); return c ? esc(c.name) : "—"; } },
    { h: "Email", get: r => r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "—" },
    { h: "Phone", get: r => esc(r.phone) || "—" },
    { h: "Status", sort: "status", get: r => pillHtml("contactStatus", r.status) },
    { h: "Owner", sort: "owner", get: r => whoHtml(r.owner) },
    { h: "Belongs to", cls: "nw", get: r => scopeHtml(r.dept, r.team) },
    { h: "Client", get: r => tagsHtml(r.tags) },
    { h: "", cls: "act", get: r => `<span class="rowacts">${editBtn("Contacts", r)}</span>` }
  ], rows, { key: "contacts", blankTitle: "No contacts", blank: "Create one with + New.",
             onRow: r => openDrawer("Contacts", r.id) });
  statusCount(`${rows.length} contacts`);
}

function renderCompanies() {
  setBar("Companies", null,
    state.scope ? "" : sel("f_tag", [{ value: "", label: "Any client" }]
      .concat(state.data.tags.map(t => ({ value: t.tag, label: t.label }))), filt("companies", "tag")));
  onFilt("companies", "tag");

  const tag = filt("companies", "tag");
  let rows = scoped(state.data.companies).filter(c =>
    (!tag || tagsOf(c.tags).indexOf(tag) >= 0) && hits(c, ["name", "city", "website", "phone", "notes"]));
  rows = sortRows(rows, "companies", "name");

  grid($("gCompanies"), [
    { h: "Company", cls: "wrap", sort: "name", get: r =>
        `<div class="prime">${esc(r.name)}</div>` + (r.website ? `<div class="sub">${esc(r.website)}</div>` : "") },
    { h: "City", sort: "city", get: r => esc(r.city) || "—" },
    { h: "Phone", get: r => esc(r.phone) || "—" },
    { h: "Contacts", cls: "num", get: r => String(state.data.contacts.filter(c => c.companyId === r.id).length) },
    { h: "Owner", sort: "owner", get: r => whoHtml(r.owner) },
    { h: "Belongs to", cls: "nw", get: r => scopeHtml(r.dept, r.team) },
    { h: "Client", get: r => tagsHtml(r.tags) },
    { h: "", cls: "act", get: r => `<span class="rowacts">${editBtn("Companies", r)}</span>` }
  ], rows, { key: "companies", blankTitle: "No companies", blank: "Create one with + New.",
             onRow: r => openDrawer("Companies", r.id) });
  statusCount(`${rows.length} companies`);
}

/* ============================================================================
   TIME
   ========================================================================== */
function renderTime() {
  setBar("Time", null,
    sel("f_range", [{ value: "today", label: "Today" }, { value: "7", label: "Last 7 days" },
                    { value: "30", label: "Last 30 days" }, { value: "all", label: "Everything" }],
        filt("time", "range", "7")) +
    sel("f_who", peopleOpts("Everyone"), filt("time", "who")) +
    `<span class="spacer"></span><button class="btn sm" id="btnManual">+ Manual entry</button>`);
  ["range", "who"].forEach(k => onFilt("time", k));
  $("btnManual").onclick = () => editSession(null);

  const range = filt("time", "range", "7");
  const from = range === "today" ? todayIso() : range === "all" ? "" : isoOffset(Number(range) - 1);
  const who = filt("time", "who");

  const rows = state.data.time.filter(t => {
    if (from && t.date < from) return false;
    if (who === "@me") { if (lc(t.userId) !== lc(state.user.userId)) return false; }
    else if (who && lc(t.userId) !== lc(who)) return false;
    const task = taskOf(t.taskId);
    if (state.scope && (!task || !inScope(task))) return false;
    return true;
  }).sort((a, b) => (b.start || "").localeCompare(a.start || ""));

  const mins = t => t.end ? (t.minutes || 0) : liveMinutes(t);
  const byPerson = {}, byTask = {};
  rows.forEach(t => {
    byPerson[t.userId] = (byPerson[t.userId] || 0) + mins(t);
    byTask[t.taskId] = (byTask[t.taskId] || 0) + mins(t);
  });
  const top = o => Object.keys(o).map(k => [k, o[k]]).sort((a, b) => b[1] - a[1]);
  const bars = (list, nameOf) => {
    if (!list.length) return `<div class="nothing">Nothing logged in this range.</div>`;
    const max = list[0][1] || 1;
    return `<div class="bars">` + list.slice(0, 8).map(([k, m]) =>
      `<div class="bar"><div class="bl"><span>${esc(nameOf(k))}</span><b>${fmtMins(m)}</b></div>` +
      `<div class="btrack"><span style="width:${Math.max(3, Math.round(m / max * 100))}%"></span></div></div>`).join("") + `</div>`;
  };
  $("timeSummary").innerHTML =
    `<div class="panel"><div class="phead"><h3>By person</h3></div><div class="pbody">${bars(top(byPerson), personName)}</div></div>` +
    `<div class="panel"><div class="phead"><h3>By task</h3></div><div class="pbody">${
      bars(top(byTask), id => { const t = taskOf(id); return t ? t.title : "(not visible)"; })}</div></div>`;

  grid($("gTime"), [
    { h: "Day", get: r => esc(fmtDay(r.date)) },
    { h: "Task", cls: "wrap", get: r => { const t = taskOf(r.taskId); return t ? `<span class="prime">${esc(t.title)}</span>` : '<span class="ro">not visible</span>'; } },
    { h: "Who", get: r => whoHtml(r.userId) },
    { h: "From", get: r => esc(fmtClock(r.start)) },
    { h: "To", get: r => r.end ? esc(fmtClock(r.end)) : `<span class="late">running</span>` },
    { h: "Time", cls: "num", get: r => fmtMins(mins(r)) },
    { h: "Note", cls: "wrap", get: r => esc(r.note) || "—" },
    { h: "", cls: "act", get: r => (lc(r.userId) === lc(state.user.userId) || state.user.role === "admin")
        ? `<span class="rowacts"><button class="btn xs" data-session="${esc(r.id)}">Edit</button></span>` : "" }
  ], rows, { key: "time", blankTitle: "No time logged",
             blank: "Start a timer on a task, or add an entry by hand." });

  statusCount(`${rows.length} sessions · ${fmtMins(rows.reduce((s, t) => s + mins(t), 0))}`);
}

/* ============================================================================
   DASHBOARD
   ========================================================================== */
function renderDash() {
  setBar("Dashboard", state.scope ? tagMeta(state.scope).label : "All tags", "");
  const me = lc(state.user.userId);
  const tasks = scoped(state.data.tasks);
  const open = tasks.filter(t => t.status !== "Done");
  const mine = open.filter(t => lc(t.assignee) === me)
    .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  const overdue = open.filter(t => t.dueDate && t.dueDate < todayIso());
  const parked = open.filter(t => t.status === state.parked);
  const todayMins = state.data.time.filter(t => t.date === todayIso() && lc(t.userId) === me)
    .reduce((s, t) => s + (t.minutes || 0), 0) + liveMinutes();

  // stages running past their target, across every flow in scope
  const stuck = [];
  tasks.forEach(t => {
    const f = flowOf(t.flowId); if (!f) return;
    const s = stageOf(f, t.stage); if (!s) return;
    const over = stageOverdue(t, s);
    if (over) stuck.push({ t, s, f, over });
  });
  stuck.sort((a, b) => b.over - a.over);

  const kpis = [
    ["My open tasks", mine.length, `${overdue.length} overdue in scope`],
    ["Logged today", fmtMins(todayMins), state.running ? "timer running" : "no timer running"],
    ["Awaiting confirmation", parked.length, parked.length ? "no deadline until they come back" : "nothing parked"],
    ["Past stage target", stuck.length, stuck.length ? "oldest " + fmtAge(stuck[0].over) + " over" : "all on time"]
  ].map(([l, v, d]) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="d">${esc(d)}</div></div>`).join("");

  const panel = (title, meta, body) =>
    `<div class="panel"><div class="phead"><h3>${esc(title)}</h3><span class="spacer"></span>` +
    `<span class="m">${esc(meta || "")}</span></div><div class="pbody">${body}</div></div>`;

  const myList = mine.length ? mine.slice(0, 7).map(t =>
    `<div class="lrow"><span class="lt">${esc(t.title)}</span><span class="spacer"></span>` +
    (t.flowId ? stageHtml(t) : pillHtml("taskStatus", t.status)) +
    `<span class="ls ${dueClass(t.dueDate, false)}">${esc(fmtDay(t.dueDate)) || "no date"}</span></div>`).join("")
    : `<div class="nothing">Nothing assigned to you.</div>`;

  const stuckList = stuck.length ? stuck.slice(0, 7).map(x =>
    `<div class="lrow"><span class="lt">${esc(x.t.title)}</span><span class="spacer"></span>` +
    `<span class="pill" style="--c:${esc(x.s.colour)}"><span class="dot"></span>${esc(x.s.name)}</span>` +
    `<span class="ls late">${esc(fmtAge(x.over))} over</span></div>`).join("")
    : `<div class="nothing">Every task is inside its stage target.</div>`;

  // where work is piling up, by stage, across flows in scope
  const load = {};
  tasks.forEach(t => {
    const f = flowOf(t.flowId); if (!f || t.status === "Done") return;
    const s = stageOf(f, t.stage); if (!s || s.terminal) return;
    const k = f.name + " › " + s.name;
    (load[k] = load[k] || { n: 0, colour: s.colour }).n++;
  });
  const loadRows = Object.keys(load).map(k => [k, load[k]]).sort((a, b) => b[1].n - a[1].n);
  const maxLoad = loadRows.length ? loadRows[0][1].n : 1;
  const loadHtml = loadRows.length ? `<div class="bars">` + loadRows.slice(0, 8).map(([k, v]) =>
    `<div class="bar"><div class="bl"><span>${esc(k)}</span><b>${v.n}</b></div>` +
    `<div class="btrack"><span style="width:${Math.round(v.n / maxLoad * 100)}%;background:${esc(v.colour)}"></span></div></div>`).join("") + `</div>`
    : `<div class="nothing">No tasks are on a flow yet.</div>`;

  // who is holding how much open work, across the flows in scope
  const byDesk = {};
  tasks.forEach(t => {
    if (t.status === "Done" || !t.assignee) return;
    byDesk[t.assignee] = (byDesk[t.assignee] || 0) + 1;
  });
  const deskRows = Object.keys(byDesk).map(k => [k, byDesk[k]]).sort((a, b) => b[1] - a[1]);
  const maxDesk = deskRows.length ? deskRows[0][1] : 1;
  const deskHtml = deskRows.length ? `<div class="bars">` + deskRows.slice(0, 8).map(([k, n]) =>
    `<div class="bar"><div class="bl"><span>${esc(personName(k))}</span><b>${n}</b></div>` +
    `<div class="btrack"><span style="width:${Math.round(n / maxDesk * 100)}%"></span></div></div>`).join("") + `</div>`
    : `<div class="nothing">Nothing open.</div>`;

  $("dashGrid").innerHTML =
    `<div class="kpis">${kpis}</div>` +
    panel("My tasks", mine.length ? mine.length + " open" : "", myList) +
    panel("Stage load", "open work by flow stage", loadHtml) +
    panel("Past stage target", stuck.length ? stuck.length + " waiting" : "", stuckList) +
    panel("Who is holding what", `${deskRows.length} people`, deskHtml);
  statusCount("");
}

/* ============================================================================
   TIMER
   ========================================================================== */
function liveMinutes(row) {
  const r = row || state.running;
  if (!r || r.end) return 0;
  const t = new Date(r.start).getTime();
  return t ? Math.max(0, Math.round((Date.now() - t) / 60000)) : 0;
}

async function startTimer(taskId) {
  try {
    const r = await API.timerStart(taskId);
    if (r.stopped) {
      const i = state.data.time.findIndex(t => t.id === r.stopped.id);
      if (i >= 0) state.data.time[i] = r.stopped; else state.data.time.push(r.stopped);
    }
    state.running = r.running;
    if (r.running && !state.data.time.some(t => t.id === r.running.id)) state.data.time.push(r.running);
    // starting the clock is what moves a task to In Progress
    if (r.task) {
      const i = state.data.tasks.findIndex(t => t.id === r.task.id);
      if (i >= 0) state.data.tasks[i] = r.task;
    }
    const t = taskOf(taskId);
    toast("Timer started" + (t ? " · " + t.title : "") + (r.task ? " · now In Progress" : ""), "ok");
    paint();
    if ($("drawer").classList.contains("on")) openDrawer("Tasks", taskId);
  } catch (err) { toast(err.message, "err"); }
}

async function stopTimer() {
  if (!state.running) return;
  try {
    const r = await API.timerStop(state.running.id);
    if (r.stopped) {
      const i = state.data.time.findIndex(t => t.id === r.stopped.id);
      if (i >= 0) state.data.time[i] = r.stopped; else state.data.time.push(r.stopped);
      toast(`Stopped · ${fmtMins(r.stopped.minutes)} logged`, "ok");
    }
    state.running = null;
    paint();
  } catch (err) { toast(err.message, "err"); }
}

function renderRunBox() {
  const box = $("runBox");
  if (!state.running) { box.classList.remove("on"); return; }
  const t = taskOf(state.running.taskId);
  $("runTask").textContent = t ? t.title : "(task not visible)";
  box.classList.add("on");
  paintClock();
}
function paintClock() {
  if (!state.running) return;
  $("runClock").textContent = hhmmss((Date.now() - new Date(state.running.start).getTime()) / 1000);
}
function startTicker() {
  clearInterval(state.tick);
  state.tick = setInterval(() => {
    if (!state.running) return;
    paintClock();
    if (new Date().getSeconds() === 0 && state.view === "tasks") paintView();
  }, 1000);
}

/* ============================================================================
   DRAWER — record detail
   ========================================================================== */
function closeDrawer() {
  $("drawer").classList.remove("on");
  $("scrim").classList.remove("on");
}

function openDrawer(entity, id) {
  const spec = SPEC[entity];
  const row = byId(state.data[entity.toLowerCase()] || [], id);
  if (!row) return;

  $("drawerTitle").textContent = spec.title(row) || spec.label;
  $("drawerCrumbs").innerHTML =
    `<span>${esc(spec.plural)}</span>` +
    (tagsOf(row.tags).length ? `<span>›</span>${tagsOf(row.tags).map(tagHtml).join("")}` : "") +
    `<span>›</span><code>${esc(row.id)}</code>`;

  const badges = [];
  if (entity === "Tasks") {
    badges.push(pillHtml("taskStatus", row.status));
    if (row.priority) badges.push(pillHtml("priority", row.priority));
    if (row.dueDate) badges.push(`<span class="${dueClass(row.dueDate, row.status === "Done")}">Due ${esc(fmtDay(row.dueDate))}</span>`);
  }
  if (entity === "Contacts") badges.push(pillHtml("contactStatus", row.status));
  if (!row._canWrite) badges.push(`<span class="ro">read only</span>`);
  $("drawerBadges").innerHTML = badges.join("");

  let html = "";

  // --- where the task is and where it can go next ---
  if (entity === "Tasks") {
    const f = flowOf(row.flowId);
    if (f) {
      const stages = flowStages(f);
      const at = stages.findIndex(s => s.key === row.stage);
      const cur = at >= 0 ? stages[at] : null;
      const chain = stages.map((s, i) => {
        const cls = i === at ? "now" : "";
        return `<span class="step ${cls}" style="--c:${esc(s.colour)}">${esc(s.name)}</span>`;
      }).join('<span class="stagearrow">·</span>');

      html += `<div class="sect"><h4>Flow — ${esc(f.name)}</h4>`;
      html += `<div class="deskcard">` +
        `<div class="dk">At this desk</div>` +
        (cur
          ? `<div class="deskrow"><span class="pill" style="--c:${esc(cur.colour)}"><span class="dot"></span>${esc(cur.name)}</span>` +
            desksHtml(cur.to) + `</div>` +
            `<div class="deskwho">${row.assignee ? whoHtml(row.assignee) : '<span class="ro">nobody yet</span>'}` +
            `<span class="ls"> · ${esc(fmtAge(stageAge(row)))} here` +
            (cur.slaHours ? ` of ${cur.slaHours}h` : "") +
            (stageOverdue(row, cur) ? ` <span class="late">${esc(fmtAge(stageOverdue(row, cur)))} over</span>` : "") +
            `</span></div>`
          : `<div class="deskrow"><span class="ro">Not started on this flow yet.</span></div>`) +
        `</div>`;

      // only the routes this flow actually allows from where the task is
      if (row._canWrite) {
        const onward = nextSteps(f, row.stage);
        if (onward.length) {
          html += `<div class="dk" style="margin-top:12px">${cur ? "Forward to" : "Send it in at"}</div><div class="fwdrow">` +
            onward.map(s => {
              const pool = staffForStep(s);
              const who = (s.to || []).length
                ? (pool.length === 1 ? personName(pool[0].userId) : pool.length + " people")
                : "anyone";
              return `<button class="fwdbtn" style="--c:${esc(s.colour)}" data-forward="${esc(s.key)}" data-task="${esc(row.id)}">` +
                     `<span class="fn">${esc(s.name)} →</span>` +
                     `<span class="fb">${(s.to || []).map(t => esc(deskLabel(t))).join(", ") || "anyone"} · ${esc(who)}</span>` +
                     `</button>`;
            }).join("") + `</div>`;
        } else if (cur && cur.terminal) {
          html += `<div class="ls" style="margin-top:10px">This is the end of the flow.</div>`;
        }
      }
      html += `</div>`;

      // every desk on the flow, for orientation — the real routes are the
      // Forward buttons above, which branch
      html += `<div class="sect"><h4>Desks on this flow</h4><div class="stepper">${chain}</div></div>`;

      const past = state.data.flowlog.filter(l => l.taskId === row.id)
        .sort((a, b) => (a.enteredAt || "").localeCompare(b.enteredAt || ""));
      if (past.length) {
        html += `<div class="sect"><h4>Hand-offs</h4>` + past.map(l => {
          const s = stageOf(f, l.stage);
          return `<div class="lrow"><span class="lt">${esc(s ? s.name : l.stage)}</span>` +
                 `<span class="ls">${l.assignee ? esc(personName(l.assignee)) : "—"}</span>` +
                 `<span class="spacer"></span>` +
                 `<span class="ls" title="sent by ${esc(personName(l.byUser))}">${esc(fmtDay(l.enteredAt.slice(0, 10)))} ${esc(fmtClock(l.enteredAt))}</span>` +
                 `<b style="font-size:11.5px">${l.exitedAt ? esc(fmtAge(l.minutes)) : esc(fmtAge(stageAge(row)))}</b></div>` +
                 (l.actingAs
                   ? `<div class="standin">${esc(personName(l.byUser))} sent this standing in as ${esc(l.actingAs)}</div>`
                   : "") +
                 (l.note ? `<div class="ls" style="padding:0 0 8px 2px">“${esc(l.note)}”</div>` : "");
        }).join("") + `</div>`;
      }
    } else if (row._canWrite && usableFlows().length) {
      html += `<div class="sect"><h4>Flow</h4><div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:9px">` +
              `Not on a flow. Put it on one and you can forward it desk to desk.</div>` +
              `<button class="btn sm" data-edit="Tasks" data-id="${esc(row.id)}">Choose a flow</button></div>`;
    }
  }

  // --- fields ---
  const bits = [];
  // owner gets its own row below; linkType only exists to pick linkId
  const skip = ["notes", "tags", "flowId", "status", "priority", "stage", "owner",
                "linkType", "name", "observers", "participants", "assignee"];
  spec.fields.forEach(f => {
    if (skip.indexOf(f.key) >= 0) return;
    if (f.key === "title" && entity !== "Contacts") return;     // already the heading
    let v = row[f.key], label = f.label;
    if (f.type === "person") v = v ? personName(v) : "";
    if (f.type === "company") { const c = company(v); v = c ? c.name : ""; }
    if (f.type === "contact") { const c = contact(v); v = c ? c.name : ""; }
    if (f.type === "link") {
      if (!row.linkId) return;
      label = "Attached to";
      const kind = { Companies: "client", Contacts: "contact" }[row.linkType] || "";
      v = linkLabel(row) + (kind ? " (" + kind + ")" : "");
    }
    if (f.type === "date") v = fmtDay(v);
    if (f.key === "value") v = v ? money(v) : "";
    bits.push(`<div><div class="k">${esc(label)}</div><div class="v">${esc(v) || "—"}</div></div>`);
  });
  html += `<div class="sect"><h4>Details</h4><div class="kv">${bits.join("")}` +
    `<div><div class="k">Owner</div><div class="v">${esc(personName(row.owner)) || "—"}</div></div>` +
    `<div><div class="k">Updated</div><div class="v">${esc(String(row.updatedAt || "").slice(0, 16).replace("T", " ")) || "—"}</div></div>` +
    `</div></div>`;

  if (entity === "Tasks") {
    const observers = tagsOf(row.observers);
    const parts = tagsOf(row.participants)
      .filter(p => p !== lc(row.owner) && p !== lc(row.assignee) && observers.indexOf(p) < 0);
    const me = lc(state.user.userId);
    const canManage = row._canWrite || lc(row.owner) === me;
    html += `<div class="sect"><h4>Who can see this</h4>` +
      `<div class="lrow"><span class="ls" style="width:76px">Raised by</span>${whoHtml(row.owner)}</div>` +
      `<div class="lrow"><span class="ls" style="width:76px">Holding it</span>${row.assignee ? whoHtml(row.assignee) : '<span class="ro">nobody</span>'}</div>` +
      `<div class="lrow"><span class="ls" style="width:76px">Observers</span>` +
        (observers.length
          ? `<span class="tags">` + observers.map(w =>
              `<span class="watch">${whoHtml(w)}` +
              ((canManage || w === me) ? `<button class="x" data-unwatch="${esc(w)}" data-task="${esc(row.id)}" title="Remove">×</button>` : "") +
              `</span>`).join("") + `</span>`
          : '<span class="ro">none</span>') +
        `<span class="spacer"></span>` +
        `<button class="btn xs" id="btnAddObserver">+ Add</button></div>` +
      (parts.length
        ? `<div class="lrow"><span class="ls" style="width:76px">Has held it</span><span class="tags">` +
          parts.map(p => whoHtml(p)).join("") + `</span></div>`
        : "") +
      `<div class="ls" style="margin-top:7px">Nobody else can see this task — tags do not open it up.</div>` +
      `</div>`;
  }

  html += `<div class="sect"><h4>Client</h4>${tagsHtml(row.tags)}</div>`;
  if (row.notes) html += `<div class="sect"><h4>Notes</h4><div class="note">${esc(row.notes)}</div></div>`;

  if (entity === "Tasks") {
    const n = state.msgCounts[row.id] || 0;
    html += `<div class="sect" id="chatSect"><h4>Chat${n ? " · " + n : ""}</h4>` +
      `<div class="chat" id="chatBody"><div class="chatload">Loading…</div></div>` +
      `<form class="chatbox" id="chatForm" autocomplete="off">` +
        `<textarea id="chatText" rows="1" placeholder="Write a message…"></textarea>` +
        `<button class="btn pri sm" type="submit" id="chatSend">Send</button>` +
      `</form>` +
      `<div class="hint">Everyone who can see this task can read the thread. Saying something puts you on the task, so you keep seeing replies.</div>` +
      `</div>`;
  }

  // --- related ---
  if (entity === "Tasks") {
    const sessions = state.data.time.filter(t => t.taskId === row.id)
      .sort((a, b) => (b.start || "").localeCompare(a.start || ""));
    html += `<div class="sect"><h4>Time — ${esc(fmtMins(taskMinutes(row.id)))} total</h4>` +
      (sessions.length ? sessions.slice(0, 12).map(s =>
        `<div class="lrow"><span class="lt">${esc(fmtDay(s.date))}</span>` +
        `<span class="ls">${esc(personName(s.userId))}</span><span class="spacer"></span>` +
        `<span class="ls">${esc(fmtClock(s.start))}–${s.end ? esc(fmtClock(s.end)) : "now"}</span>` +
        `<b style="font-size:11.5px">${esc(fmtMins(s.end ? s.minutes : liveMinutes(s)))}</b></div>`).join("")
        : `<div class="nothing">No time logged yet.</div>`) + `</div>`;
  } else {
    if (entity === "Companies") {
      const people = state.data.contacts.filter(c => c.companyId === row.id);
      if (people.length) html += `<div class="sect"><h4>Contacts</h4>` + people.map(c =>
        `<div class="lrow"><span class="lt">${esc(c.name)}</span><span class="ls">${esc(c.title)}</span>` +
        `<span class="spacer"></span>${pillHtml("contactStatus", c.status)}</div>`).join("") + `</div>`;
    }
    const rel = state.data.tasks.filter(t => t.linkType === entity && t.linkId === row.id);
    if (rel.length) html += `<div class="sect"><h4>Tasks</h4>` + rel.map(t =>
      `<div class="lrow"><span class="lt">${esc(t.title)}</span><span class="spacer"></span>` +
      (t.flowId ? stageHtml(t) : pillHtml("taskStatus", t.status)) +
      `<span class="ls ${dueClass(t.dueDate, t.status === "Done")}">${esc(fmtDay(t.dueDate))}</span></div>`).join("") + `</div>`;
  }

  $("drawerBody").innerHTML = html;

  const foot = [];
  if (entity === "Tasks") {
    const live = state.running && state.running.taskId === row.id;
    const mine = row._canWrite || lc(row.assignee) === lc(state.user.userId);
    if (mine) foot.push(`<button class="btn" data-timer="${esc(row.id)}">${live ? "■ Stop timer" : "▶ Start timer"}</button>`);
  }
  foot.push(`<span class="spacer"></span>`);
  if (row._canWrite) foot.push(`<button class="btn pri" data-edit="${esc(entity)}" data-id="${esc(row.id)}">Edit</button>`);
  $("drawerFoot").innerHTML = foot.join("");

  if ($("btnAddObserver")) $("btnAddObserver").onclick = () => addObserver(row.id);
  if (entity === "Tasks") mountChat(row);

  $("drawer").classList.add("on");
  $("scrim").classList.add("on");
}

/* ---------- task chat ---------- */
function renderChat(taskId) {
  const box = $("chatBody");
  if (!box) return;
  const list = state.messages[taskId];
  if (!list) { box.innerHTML = `<div class="chatload">Loading…</div>`; return; }
  if (!list.length) { box.innerHTML = `<div class="chatload">No messages yet.</div>`; return; }

  const me = lc(state.user.userId);
  let lastDay = "", html = "";
  list.forEach(m => {
    const day = String(m.at || "").slice(0, 10);
    if (day && day !== lastDay) {
      lastDay = day;
      html += `<div class="chatday">${esc(day === todayIso() ? "Today" : fmtDay(day))}</div>`;
    }
    const mine = lc(m.userId) === me;
    html += `<div class="msg${mine ? " mine" : ""}">` +
      `<div class="mhead"><span class="av">${esc(initials(personName(m.userId)))}</span>` +
      `<b>${esc(mine ? "You" : personName(m.userId))}</b>` +
      `<span class="ls">${esc(fmtClock(m.at))}</span></div>` +
      `<div class="mtext">${esc(m.text)}</div></div>`;
  });
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

async function mountChat(row) {
  const form = $("chatForm");
  if (!form) return;
  const taskId = row.id;

  renderChat(taskId);
  if (!state.messages[taskId]) {
    try {
      const r = await API.messages(taskId);
      state.messages[taskId] = r.messages || [];
      state.msgCounts[taskId] = state.messages[taskId].length;
    } catch (err) {
      state.messages[taskId] = [];
      const box = $("chatBody");
      if (box) box.innerHTML = `<div class="chatload">Could not load the thread: ${esc(err.message)}</div>`;
      return;
    }
    // the drawer may have moved on to another record while that was in flight
    if ($("chatForm") !== form) return;
    renderChat(taskId);
  }

  const text = $("chatText");
  // grow the box with the message, up to a point
  text.addEventListener("input", () => {
    text.style.height = "auto";
    text.style.height = Math.min(text.scrollHeight, 130) + "px";
  });
  text.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  form.onsubmit = async e => {
    e.preventDefault();
    const body = text.value.trim();
    if (!body) return;
    $("chatSend").disabled = true;
    try {
      const r = await API.postMessage(taskId, body);
      (state.messages[taskId] = state.messages[taskId] || []).push(r.message);
      state.msgCounts[taskId] = state.messages[taskId].length;
      text.value = ""; text.style.height = "auto";
      renderChat(taskId);
      // posting puts you on the task, so the list may have changed
      const t = taskOf(taskId);
      if (t) t.participants = (t.participants ? t.participants + ", " : "") + lc(state.user.userId);
    } catch (err) {
      toast(err.message, "err");
    } finally {
      const b = $("chatSend");
      if (b) b.disabled = false;
      if ($("chatText")) $("chatText").focus();
    }
  };
}

async function setObserver(taskId, who, remove) {
  try {
    const r = await API.watch(taskId, who, remove);
    const i = state.data.tasks.findIndex(t => t.id === taskId);
    if (i >= 0) {
      // taking yourself off a task you are not otherwise on removes your sight of it
      const gone = remove && lc(who) === lc(state.user.userId) &&
                   lc(r.task.owner) !== lc(state.user.userId) &&
                   lc(r.task.assignee) !== lc(state.user.userId) &&
                   tagsOf(r.task.participants).indexOf(lc(state.user.userId)) < 0;
      if (gone) { state.data.tasks.splice(i, 1); closeDrawer(); }
      else state.data.tasks[i] = r.task;
    }
    toast(remove ? "Observer removed" : "Observer added", "ok");
    paint();
    if ($("drawer").classList.contains("on")) openDrawer("Tasks", taskId);
  } catch (err) { toast(err.message, "err"); }
}

function addObserver(taskId) {
  const t = taskOf(taskId);
  const on = tagsOf(t.observers).concat([lc(t.owner), lc(t.assignee)]);
  const pool = state.data.people.filter(p => on.indexOf(lc(p.userId)) < 0);
  if (!pool.length) { toast("Everyone is already on this task.", "err"); return; }
  modal({
    title: "Add an observer",
    saveLabel: "Add",
    body: `<div class="field"><label>Who</label><select class="inp" id="awWho">` +
      pool.map(p => `<option value="${esc(p.userId)}">${esc(p.name)}${p.posts && p.posts.length ? " — " + esc(p.posts.map(q => deskLabel(postingText(q))).join(", ")) : ""}</option>`).join("") +
      `</select><div class="hint">An observer can see the task and follow where it goes, but cannot change it unless it is handed to them.</div></div>`,
    after: () => modalSave(async () => {
      await setObserver(taskId, $("awWho").value, false);
      closeModal();
    })
  });
}

/* ============================================================================
   MODAL + EDITOR
   ========================================================================== */
let modalSaveFn = null;
function modal(opts) {
  $("modalTitle").textContent = opts.title;
  $("modalBody").innerHTML = opts.body || "";
  $("modalErr").textContent = "";
  $("btnModalDelete").style.display = opts.onDelete ? "inline-flex" : "none";
  $("btnModalSave").style.display = opts.hideSave ? "none" : "inline-flex";
  $("btnModalSave").textContent = opts.saveLabel || "Save";
  // a dialog that never calls modalSave() must not inherit the last one's
  // action — otherwise Save would fire whatever the previous modal wired up
  modalSaveFn = null;
  $("btnModalSave").onclick = null;
  $("btnModalDelete").onclick = opts.onDelete || null;
  $("modal").classList.add("on");
  $("scrim").classList.add("on");
  if (opts.after) opts.after();
  const first = $("modalBody").querySelector("input,select,textarea");
  if (first && !opts.noFocus) first.focus();
}
function modalSave(fn) {
  modalSaveFn = fn;
  $("btnModalSave").onclick = async () => {
    $("btnModalSave").disabled = true;
    $("modalErr").textContent = "";
    try { await fn(); }
    catch (err) { $("modalErr").textContent = err.message; }
    finally { $("btnModalSave").disabled = false; }
  };
}
function closeModal() {
  $("modal").classList.remove("on");
  if (!$("drawer").classList.contains("on")) $("scrim").classList.remove("on");
}

let editing = null;
function openEditor(entity, id) {
  const spec = SPEC[entity];
  if (!spec) return;
  const list = state.data[entity.toLowerCase()] || [];
  const row = id ? byId(list, id) : null;
  if (id && !row) { toast("That record is gone — reload.", "err"); return; }
  if (row && !row._canWrite) return openDrawer(entity, id);

  const draft = {};
  spec.fields.forEach(f => { draft[f.key] = row ? (row[f.key] ?? "") : ""; });
  // "scope" is a pair of real columns, not a field of its own
  draft.dept = row ? (row.dept || "") : "";
  draft.team = row ? (row.team || "") : "";
  if (!row) {
    draft.owner = state.user.userId;
    if (entity === "Tasks") {
      draft.assignee = state.user.userId;
      draft.status = ((state.data.lists.taskStatus || [{}])[0] || {}).value || "Todo";
      draft.priority = "Normal";
    }
    if (entity === "Contacts") draft.status = ((state.data.lists.contactStatus || [{}])[0] || {}).value || "";
    /* A new record should not be born private: put it where the person is
       standing, or at the first place they can write to. */
    const here = state.scope ? { dept: state.scope.split(".")[0], team: state.scope.split(".")[1] || "" } : null;
    const pick = (here && canWriteScope(here.dept, here.team)) ? here : myWritableScopes()[0];
    if (pick) { draft.dept = pick.dept; draft.team = pick.team || ""; }
  }
  editing = { entity, id: row ? row.id : "", draft,
              wasFlow: row ? row.flowId : "", wasStatus: row ? row.status : "" };

  modal({
    title: (row ? "Edit " : "New ") + spec.label.toLowerCase(),
    body: "",
    onDelete: row ? async () => {
      if (!confirm(`Delete this ${spec.label.toLowerCase()}? This cannot be undone.`)) return;
      try {
        await API.remove(entity, editing.id);
        const arr = state.data[entity.toLowerCase()];
        const i = arr.findIndex(r => r.id === editing.id);
        if (i >= 0) arr.splice(i, 1);
        closeModal(); closeDrawer();
        toast(`${spec.label} deleted`, "ok");
        paint();
      } catch (err) { $("modalErr").textContent = err.message; }
    } : null,
    after: () => {
      paintFields();
      modalSave(saveEditor);
    }
  });
}

function paintFields() {
  const spec = SPEC[editing.entity];
  const body = $("modalBody");
  body.innerHTML = "";
  let row = el("div", "frow");
  spec.fields.forEach(f => {
    if (f.key === "linkId" && !editing.draft.linkType) return;
    // on a flow, who holds the task is decided by forwarding, not by typing
    if (f.key === "assignee" && editing.draft.flowId) return;
    /* A parked task has no deadline by definition, so the field goes away;
       coming back off the park, it returns and has to be filled. */
    if (f.key === "dueDate" && editing.draft.status === state.parked) {
      editing.draft.dueDate = "";
      return;
    }
    if (f.full && row.children.length) { body.appendChild(row); row = el("div", "frow"); }
    row.appendChild(fieldNode(f));
    if (f.full) { body.appendChild(row); row = el("div", "frow"); }
  });
  if (row.children.length) body.appendChild(row);
}

function fieldNode(f) {
  const wrap = el("div", "field");
  wrap.appendChild(el("label", "", esc(f.label) + (f.required ? " *" : "")));
  const v = editing.draft[f.key] ?? "";

  if (f.type === "tags") {
    const pick = el("div", "tagpick");
    const chosen = tagsOf(v);
    const all = state.data.tags.slice();
    chosen.forEach(t => { if (!all.some(x => x.tag === t)) all.push(tagMeta(t)); });
    if (!all.length) pick.innerHTML = '<span class="ro">no tags defined yet</span>';
    all.forEach(t => {
      const on = chosen.indexOf(t.tag) >= 0;
      const b = el("button", on ? "on" : "", esc(t.label));
      b.type = "button";
      b.style.setProperty("--c", t.colour);
      b.disabled = !canWriteTag(t.tag) && !on;
      b.onclick = () => {
        const list = tagsOf(editing.draft[f.key]);
        const i = list.indexOf(t.tag);
        if (i >= 0) list.splice(i, 1); else list.push(t.tag);
        editing.draft[f.key] = list.join(", ");
        paintFields();
      };
      pick.appendChild(b);
    });
    wrap.appendChild(pick);
    if (f.hint) wrap.appendChild(el("div", "hint", esc(f.hint)));
    return wrap;
  }

  if (f.type === "scope") {
    const box = el("div", "scopefield");
    const dSel = el("select", "inp");
    const writable = myWritableScopes();
    const deptOk = d => state.user.all || writable.some(w => w.dept === d);
    dSel.innerHTML = `<option value="">— nobody but me —</option>` +
      state.data.departments.filter(d => deptOk(d.dept) || d.dept === lc(editing.draft.dept))
        .map(d => `<option value="${esc(d.dept)}"${lc(editing.draft.dept) === d.dept ? " selected" : ""}>${esc(d.label)}</option>`).join("");
    dSel.addEventListener("input", () => {
      editing.draft.dept = dSel.value;
      editing.draft.team = "";
      paintFields();
    });
    box.appendChild(dSel);

    const teams = teamsIn(editing.draft.dept);
    if (teams.length) {
      const tSel = el("select", "inp");
      const teamOk = t => state.user.all ||
        writable.some(w => w.dept === lc(editing.draft.dept) && (!w.team || w.team === t));
      tSel.innerHTML = `<option value="">Whole department</option>` +
        teams.filter(t => teamOk(t.team) || lc(editing.draft.team) === t.team)
          .map(t => `<option value="${esc(t.team)}"${lc(editing.draft.team) === t.team ? " selected" : ""}>${esc(t.label)}</option>`).join("");
      tSel.addEventListener("input", () => { editing.draft.team = tSel.value; });
      box.appendChild(tSel);
    }
    wrap.appendChild(box);
    if (f.hint) wrap.appendChild(el("div", "hint", esc(f.hint)));
    return wrap;
  }

  if (f.type === "people") {
    const pick = el("div", "tagpick");
    const chosen = tagsOf(v);
    state.data.people.forEach(p => {
      if (lc(p.userId) === lc(editing.draft.owner || state.user.userId)) return;
      const on = chosen.indexOf(lc(p.userId)) >= 0;
      const b = el("button", on ? "on" : "", esc(p.name));
      b.type = "button";
      b.style.setProperty("--c", "#60a5fa");
      b.onclick = () => {
        const list = tagsOf(editing.draft[f.key]);
        const i = list.indexOf(lc(p.userId));
        if (i >= 0) list.splice(i, 1); else list.push(lc(p.userId));
        editing.draft[f.key] = list.join(", ");
        paintFields();
      };
      pick.appendChild(b);
    });
    if (!pick.children.length) pick.innerHTML = '<span class="ro">nobody else on the roster</span>';
    wrap.appendChild(pick);
    if (f.hint) wrap.appendChild(el("div", "hint", esc(f.hint)));
    return wrap;
  }

  let node;
  if (f.type === "textarea") { node = el("textarea"); node.value = v; }
  else if (["select", "person", "company", "contact", "link", "flow"].indexOf(f.type) >= 0) {
    node = el("select");
    let opts;
    if (f.type === "select") {
      opts = f.options || (state.data.lists[f.list] || []).map(o => ({ value: o.value, label: o.label }));
      if (!f.required && !opts.some(o => o.value === "")) opts = [{ value: "", label: "—" }].concat(opts);
    } else if (f.type === "person") {
      opts = [{ value: "", label: "Nobody" }].concat(state.data.people.map(p => ({ value: p.userId, label: p.name })));
    } else if (f.type === "company") {
      opts = [{ value: "", label: "—" }].concat(state.data.companies.map(c => ({ value: c.id, label: c.name })));
    } else if (f.type === "contact") {
      const co = editing.draft.companyId;
      const list = co ? state.data.contacts.filter(c => c.companyId === co) : state.data.contacts;
      opts = [{ value: "", label: "—" }].concat(list.map(c => ({ value: c.id, label: c.name })));
    } else if (f.type === "flow") {
      opts = [{ value: "", label: "No flow" }].concat(usableFlows().map(fl =>
        ({ value: fl.id, label: fl.name + " (" + flowStages(fl).length + " stages)" })));
    } else {
      const t = editing.draft.linkType;
      const src = t === "Companies" ? state.data.companies
                : t === "Contacts" ? state.data.contacts
                : [];
      opts = [{ value: "", label: "—" }].concat(src.map(r => ({ value: r.id, label: r.name || r.title })));
    }
    node.innerHTML = opts.map(o =>
      `<option value="${esc(o.value)}"${String(o.value) === String(v) ? " selected" : ""}>${esc(o.label)}</option>`).join("");
  } else {
    node = el("input");
    node.type = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
    if (f.type === "number") node.step = "any";
    node.value = v;
  }
  node.addEventListener("input", () => {
    editing.draft[f.key] = node.value;
    // these three reshape the rest of the form
    if (f.key === "linkType" || f.key === "companyId" || f.key === "status") paintFields();
  });
  wrap.appendChild(node);

  let hint = f.hint;
  if (f.key === "status" && editing.draft.status === state.parked) {
    hint = "Parked. The deadline is cleared while you wait; you will be asked for a new one when you move it on.";
  }
  if (f.key === "dueDate" && editing.wasStatus === state.parked && editing.draft.status !== state.parked) {
    wrap.classList.add("needs");
    hint = "This task was parked. Set a new deadline before saving.";
  }
  if (hint) wrap.appendChild(el("div", "hint", esc(hint)));
  return wrap;
}

async function saveEditor() {
  const spec = SPEC[editing.entity];
  for (const f of spec.fields) {
    if (f.required && !String(editing.draft[f.key] || "").trim()) throw new Error(f.label + " is required.");
  }
  const record = Object.assign({}, editing.draft);
  delete record.scope;                       // dept and team carry it instead
  if (editing.id) record.id = editing.id;
  // moving off a flow, or onto a different one, drops the old stage
  if (editing.entity === "Tasks" && record.flowId !== editing.wasFlow) record.stage = "";

  if (editing.entity === "Tasks") {
    // parking a task drops its deadline; coming back off needs a new one
    if (record.status === state.parked) record.dueDate = "";
    else if (editing.wasStatus === state.parked && !String(record.dueDate || "").trim()) {
      throw new Error("Set a new deadline — this task has been parked since confirmations went out.");
    }
  }

  const r = await API.save(editing.entity, record);
  const arr = state.data[editing.entity.toLowerCase()];
  const i = arr.findIndex(x => x.id === r.record.id);
  if (i >= 0) arr[i] = r.record; else arr.push(r.record);
  closeModal();
  toast(`${spec.label} saved`, "ok");

  // a task newly put on a flow starts at its first stage
  if (editing.entity === "Tasks" && r.record.flowId && !r.record.stage) {
    const f = flowOf(r.record.flowId);
    const first = flowStages(f)[0];
    const entry = nextSteps(f, "")[0];
    if (entry) { await forward(r.record.id, entry.key); return; }
  }
  paint();
  if ($("drawer").classList.contains("on")) openDrawer(editing.entity, r.record.id);
}

/* ============================================================================
   MANUAL TIME
   ========================================================================== */
function editSession(row) {
  const tasks = scoped(state.data.tasks).slice().sort((a, b) => lc(a.title) < lc(b.title) ? -1 : 1);
  if (!tasks.length) { toast("Add a task first — time is always logged against one.", "err"); return; }
  const d = row || { taskId: tasks[0].id, date: todayIso(), start: "", end: "", minutes: 30, note: "" };

  modal({
    title: row ? "Edit session" : "Manual time entry",
    body:
      `<div class="field"><label>Task</label><select class="inp" id="teTask">` +
      tasks.map(t => `<option value="${esc(t.id)}"${t.id === d.taskId ? " selected" : ""}>${esc(t.title)}</option>`).join("") +
      `</select></div>` +
      `<div class="frow">` +
        `<div class="field"><label>Day</label><input class="inp" id="teDate" type="date" value="${esc(String(d.date || todayIso()).slice(0, 10))}"></div>` +
        `<div class="field"><label>Minutes</label><input class="inp" id="teMins" type="number" min="0" step="1" value="${esc(d.minutes || 0)}"></div>` +
      `</div>` +
      `<div class="frow">` +
        `<div class="field"><label>From</label><input class="inp" id="teFrom" type="time" value="${esc(fmtClock(d.start))}"></div>` +
        `<div class="field"><label>To</label><input class="inp" id="teTo" type="time" value="${esc(fmtClock(d.end))}"></div>` +
      `</div>` +
      `<div class="field"><label>Note</label><input class="inp" id="teNote" value="${esc(d.note || "")}">` +
      `<div class="hint">Give either a from/to pair or a number of minutes — if both are filled, from/to wins.</div></div>`,
    onDelete: row ? async () => {
      if (!confirm("Delete this session?")) return;
      try {
        await API.timeRemove(row.id);
        const i = state.data.time.findIndex(t => t.id === row.id);
        if (i >= 0) state.data.time.splice(i, 1);
        if (state.running && state.running.id === row.id) state.running = null;
        closeModal(); toast("Session deleted", "ok"); paint();
      } catch (err) { $("modalErr").textContent = err.message; }
    } : null,
    after: () => modalSave(async () => {
      const day = $("teDate").value || todayIso();
      const from = $("teFrom").value, to = $("teTo").value;
      const record = { id: row ? row.id : "", taskId: $("teTask").value, date: day, note: $("teNote").value.trim() };
      // a saved session always gets an end: an open row is what the backend
      // treats as a running timer, and a typed entry is not one
      if (from && to) {
        record.start = new Date(`${day}T${from}:00`).toISOString();
        record.end = new Date(`${day}T${to}:00`).toISOString();
      } else {
        record.start = new Date(`${day}T${from || "09:00"}:00`).toISOString();
        record.minutes = Math.max(0, Number($("teMins").value) || 0);
        record.end = new Date(new Date(record.start).getTime() + record.minutes * 60000).toISOString();
      }
      const r = await API.timeSave(record);
      const i = state.data.time.findIndex(t => t.id === r.record.id);
      if (i >= 0) state.data.time[i] = r.record; else state.data.time.push(r.record);
      closeModal(); toast("Session saved", "ok"); paint();
    })
  });
}

/* ============================================================================
   ADMIN
   ========================================================================== */
async function loadAdmin() {
  if (state.user.role !== "admin") return;
  try { state.users = (await API.adminUsers()).users || []; }
  catch (err) { return toast(err.message, "err"); }
  renderAdmin();
}

function renderAdmin() {
  setBar("Admin", `${state.users.length} people · ${state.data.departments.length} departments · ` +
    `${state.data.teams.length} teams · ${state.data.positions.length} positions`, "");

  grid($("gUsers"), [
    { h: "User ID", get: r => `<code>${esc(r.userId)}</code>` },
    { h: "Name", get: r => esc(r.name) || "—" },
    { h: "Role", get: r => r.role === "admin" ? `<span class="pill" style="--c:#2dd4bf"><span class="dot"></span>admin</span>` : "user" },
    { h: "Postings — what they can reach", cls: "wrap", get: r => postingsHtml(r.postings) },
    { h: "Client tags", cls: "wrap", get: r => tagsOf(r.tags).length ? tagsHtml(r.tags) : '<span class="ro">—</span>' },
    { h: "Active", cls: "nw", get: r => r.active
        ? `<span class="pill" style="--c:#34d399"><span class="dot"></span>on</span>`
        : `<span class="pill" style="--c:#f87171"><span class="dot"></span>off</span>` },
    { h: "", cls: "act", get: r => `<span class="rowacts"><button class="btn xs" data-user="${esc(r.userId)}">Edit</button></span>` }
  ], state.users, { key: "users", blankTitle: "No users" });

  const orgBtn = (kind, key) =>
    `<span class="rowacts"><button class="btn xs" data-org="${esc(kind)}" data-key="${esc(key)}">Edit</button></span>`;

  grid($("gDepts"), [
    { h: "Department", get: r => deptHtml(r.dept) },
    { h: "Key", get: r => `<code>${esc(r.dept)}</code>` },
    { h: "Teams", cls: "wrap", get: r => {
        const t = teamsIn(r.dept);
        return t.length ? t.map(x => esc(x.label)).join(", ") : '<span class="ro">none</span>';
      } },
    { h: "People", cls: "num", get: r => String(state.data.people.filter(p =>
        (p.posts || []).some(q => q.dept === r.dept)).length) },
    { h: "", cls: "act", get: r => orgBtn("Departments", r.dept) }
  ], state.data.departments, {
    key: "depts", blankTitle: "No departments",
    blank: "A department is the top of the org chart — CSM, Ops, CRO."
  });

  grid($("gTeams"), [
    { h: "Team", get: r => `<span class="badge" style="--c:${esc(r.colour)}">${esc(r.label)}</span>` },
    { h: "Inside", cls: "nw", get: r => deptHtml(r.dept) },
    { h: "Key", get: r => `<code>${esc(r.dept)}.${esc(r.team)}</code>` },
    { h: "People", cls: "num", get: r => String(state.data.people.filter(p =>
        (p.posts || []).some(q => q.dept === r.dept && q.team === r.team)).length) },
    { h: "", cls: "act", get: r => orgBtn("Teams", r.team) }
  ], state.data.teams, {
    key: "teams", blankTitle: "No teams",
    blank: "Teams sit inside a department — CRO has CS, GD and SD."
  });

  grid($("gPositions"), [
    { h: "Position", get: r => `<span class="pos" style="--c:${esc(r.colour)}">${esc(r.label)}</span>` },
    { h: "Key", get: r => `<code>${esc(r.position)}</code>` },
    { h: "Rank", cls: "num", get: r => String(r.rank) },
    { h: "Acts as", cls: "nw", get: r => {
        if (r.acts <= r.rank) return '<span class="ro">itself</span>';
        const up = state.data.positions.filter(p => p.rank === r.acts)[0];
        return `<span class="pos" style="--c:${esc((up || r).colour)}">${esc(up ? up.label : "rank " + r.acts)}</span>` +
               ` <span class="ro">flagged when used</span>`;
      } },
    { h: "Access", cls: "nw", get: r => r.access === "read"
        ? `<span class="pill" style="--c:#94a3b8"><span class="dot"></span>read</span>`
        : `<span class="pill" style="--c:#34d399"><span class="dot"></span>write</span>` },
    { h: "People", cls: "num", get: r => String(state.data.people.filter(p =>
        (p.posts || []).some(q => q.position === r.position)).length) },
    { h: "", cls: "act", get: r => orgBtn("Positions", r.position) }
  ], state.data.positions, {
    key: "positions", blankTitle: "No positions",
    blank: "Manager, TL, Next Inline, Member. Rank decides what counts as a TL-level act."
  });

  grid($("gTags"), [
    { h: "Tag", get: r => tagHtml(r.tag) },
    { h: "Key", get: r => `<code>${esc(r.tag)}</code>` },
    { h: "Label", get: r => esc(r.label) },
    { h: "Colour", get: r => `<code>${esc(r.colour)}</code>` },
    { h: "Flows", cls: "num", get: r => String(state.data.flows.filter(f => tagsOf(f.tags).indexOf(r.tag) >= 0).length) },
    { h: "Records", cls: "num", get: r => String(["companies", "contacts", "tasks"]
        .reduce((s, k) => s + state.data[k].filter(x => tagsOf(x.tags).indexOf(r.tag) >= 0).length, 0)) },
    { h: "", cls: "act", get: r => `<span class="rowacts"><button class="btn xs" data-tagedit="${esc(r.tag)}">Edit</button></span>` }
  ], state.data.tags, { key: "tags", blankTitle: "No tags", blank: "Add one with + Tag." });
  statusCount("");
}

function editUser(row) {
  const d = row || { userId: "", name: "", email: "", role: "user", tags: "", active: true };
  modal({
    title: row ? "Edit user" : "New user",
    body:
      `<div class="frow">` +
        `<div class="field"><label>User ID *</label><input class="inp" id="auId" value="${esc(d.userId)}" ${row ? "disabled" : ""} autocapitalize="none" spellcheck="false"></div>` +
        `<div class="field"><label>Name</label><input class="inp" id="auName" value="${esc(d.name)}"></div>` +
      `</div>` +
      `<div class="frow">` +
        `<div class="field"><label>Email</label><input class="inp" id="auEmail" value="${esc(d.email)}"></div>` +
        `<div class="field"><label>Role</label><select class="inp" id="auRole">` +
          `<option value="user"${d.role !== "admin" ? " selected" : ""}>User</option>` +
          `<option value="admin"${d.role === "admin" ? " selected" : ""}>Admin</option></select></div>` +
      `</div>` +
      `<div class="field"><label>Postings — what they can reach</label>` +
        `<div class="postlist" id="auPosts"></div>` +
        `<div id="auBuild"></div>` +
        `<button class="btn xs" type="button" id="auAddPost" style="margin-top:7px">+ Posting</button>` +
        `<div class="hint">A posting is a department, optionally a team inside it, and a position. ` +
        `The position decides read or write; you can override that here for one person.</div></div>` +
      `<div class="field"><label>Client tags</label><input class="inp" id="auTags" value="${esc(d.tags)}" placeholder="bm, rw">` +
        `<div class="hint">Labels only, for filtering. Known: ${state.data.tags.map(t => `<code>${esc(t.tag)}</code>`).join(", ") || "none yet"}</div></div>` +
      `<div class="frow">` +
        `<div class="field"><label>${row ? "New password (blank = leave it)" : "Password *"}</label><input class="inp" id="auPw" type="text" autocomplete="off"></div>` +
        `<div class="field"><label>Active</label><select class="inp" id="auActive">` +
          `<option value="1"${d.active ? " selected" : ""}>On</option><option value="0"${!d.active ? " selected" : ""}>Off</option></select></div>` +
      `</div>`,
    after: () => {
      const picked = postingsOf(d.postings).map(postingText);
      const paintPosts = () => {
        $("auPosts").innerHTML = picked.length
          ? picked.map(p =>
              `<span class="target">${p === "*" ? '<span class="badge" style="--c:#2dd4bf">Everything</span>' : postingHtml(parsePosting(p))}` +
              `<button type="button" class="x" data-rm="${esc(p)}" title="Remove">×</button></span>`).join("")
          : '<span class="ro">none — they will reach nothing</span>';
      };
      paintPosts();
      $("auPosts").onclick = e => {
        const b = e.target.closest("button[data-rm]"); if (!b) return;
        const i = picked.indexOf(b.dataset.rm);
        if (i >= 0) picked.splice(i, 1);
        paintPosts();
      };
      $("auAddPost").onclick = () => buildPosting($("auBuild"), p => {
        if (picked.indexOf(p) < 0) picked.push(p);
        paintPosts();
      });

      modalSave(async () => {
      const record = {
        userId: row ? row.userId : $("auId").value.trim(),
        name: $("auName").value.trim(), email: $("auEmail").value.trim(),
        role: $("auRole").value, tags: $("auTags").value, postings: picked.join(", "),
        active: $("auActive").value === "1", password: $("auPw").value
      };
      if (!record.userId) throw new Error("A user ID is required.");
      if (!row && !record.password) throw new Error("Give the new account a password.");
      await API.saveUser(record);
      closeModal(); toast("User saved", "ok");
      await loadAdmin(); await reload();
      });
    }
  });
}


/* Build one posting inline — a nested dialog would throw away whatever the
   user editor already has in it. Calls back with "cro.sd.tl" or "cro.sd.tl:r". */
function buildPosting(host, done) {
  if (!state.data.departments.length) { toast("Add a department first.", "err"); return; }
  if (!state.data.positions.length) { toast("Add a position first.", "err"); return; }
  const d = {
    dept: state.data.departments[0].dept, team: "",
    position: state.data.positions[0].position, override: ""
  };

  const paint = () => {
    const teams = teamsIn(d.dept);
    const pos = posMeta(d.position);
    host.innerHTML =
      `<div class="buildrow">` +
        `<select class="inp" id="bpDept">` + state.data.departments.map(x =>
          `<option value="${esc(x.dept)}"${x.dept === d.dept ? " selected" : ""}>${esc(x.label)}</option>`).join("") + `</select>` +
        `<select class="inp" id="bpTeam"${teams.length ? "" : " disabled"}>` +
          `<option value="">Whole department</option>` + teams.map(t =>
          `<option value="${esc(t.team)}"${t.team === d.team ? " selected" : ""}>${esc(t.label)}</option>`).join("") + `</select>` +
        `<select class="inp" id="bpPos">` + state.data.positions.map(p =>
          `<option value="${esc(p.position)}"${p.position === d.position ? " selected" : ""}>${esc(p.label)}</option>`).join("") + `</select>` +
        `<select class="inp" id="bpAcc">` +
          `<option value=""${!d.override ? " selected" : ""}>${esc(pos.access)} (from position)</option>` +
          `<option value="write"${d.override === "write" ? " selected" : ""}>write (exception)</option>` +
          `<option value="read"${d.override === "read" ? " selected" : ""}>read (exception)</option>` +
        `</select>` +
        `<button class="btn pri xs" type="button" id="bpAdd">Add</button>` +
        `<button class="btn xs" type="button" id="bpNo">Cancel</button>` +
      `</div>` +
      `<div class="hint">→ <code>${esc(postingText(d))}</code> · ` +
      (d.team ? `just the ${esc(teamMeta(d.team).label)} team` : `every team in ${esc(deptMeta(d.dept).label)}`) +
      (pos.acts > pos.rank ? ` · stands in at the rank above, and those acts get flagged` : "") + `</div>`;

    $("bpDept").addEventListener("input", e => { d.dept = e.target.value; d.team = ""; paint(); });
    const t = $("bpTeam"); if (t) t.addEventListener("input", e => { d.team = e.target.value; paint(); });
    $("bpPos").addEventListener("input", e => { d.position = e.target.value; paint(); });
    $("bpAcc").addEventListener("input", e => { d.override = e.target.value; paint(); });
    $("bpAdd").onclick = () => { done(postingText(d)); host.innerHTML = ""; };
    $("bpNo").onclick = () => { host.innerHTML = ""; };
  };
  paint();
}

/* One editor for all three org catalogues — they differ only in a field or
   two, and keeping them together keeps the rules in one place. */
function editOrg(kind, row) {
  const cfg = {
    Departments: { col: "dept",     noun: "department", src: () => state.data.departments, ph: "cro",  phl: "CRO" },
    Teams:       { col: "team",     noun: "team",       src: () => state.data.teams,       ph: "sd",   phl: "SD" },
    Positions:   { col: "position", noun: "position",   src: () => state.data.positions,   ph: "tl",   phl: "TL" }
  }[kind];
  if (!cfg) return;

  const d = row || { label: "", colour: STAGE_COLOURS[6], order: cfg.src().length,
                     dept: (state.data.departments[0] || {}).dept || "",
                     rank: 10, acts: 10, access: "write" };
  const key = row ? row[cfg.col] : "";

  let extra = "";
  if (kind === "Teams") {
    extra = `<div class="field"><label>Inside which department *</label><select class="inp" id="eoDept">` +
      state.data.departments.map(x =>
        `<option value="${esc(x.dept)}"${x.dept === d.dept ? " selected" : ""}>${esc(x.label)}</option>`).join("") +
      `</select></div>`;
  }
  if (kind === "Positions") {
    const rankOpts = [{ value: "10", label: "10 — team member" }, { value: "15", label: "15 — stands in for a TL" },
                      { value: "20", label: "20 — TL" }, { value: "30", label: "30 — Manager" }];
    extra =
      `<div class="frow">` +
        `<div class="field"><label>Rank</label><select class="inp" id="eoRank">` +
          rankOpts.map(o => `<option value="${esc(o.value)}"${String(d.rank) === o.value ? " selected" : ""}>${esc(o.label)}</option>`).join("") +
        `</select><div class="hint">Where they stand in the org. Anything needing rank 20 or more is a TL-level act.</div></div>` +
        `<div class="field"><label>Acts at rank</label><select class="inp" id="eoActs">` +
          rankOpts.map(o => `<option value="${esc(o.value)}"${String(d.acts) === o.value ? " selected" : ""}>${esc(o.label)}</option>`).join("") +
        `</select><div class="hint">Set this above their own rank and they can stand in — their TL-level acts get recorded as such. Next Inline is rank 15 acting at 20.</div></div>` +
      `</div>` +
      `<div class="field"><label>Default access</label><select class="inp" id="eoAccess">` +
        `<option value="write"${d.access !== "read" ? " selected" : ""}>Write — can change what they reach</option>` +
        `<option value="read"${d.access === "read" ? " selected" : ""}>Read — can look, not change</option>` +
      `</select><div class="hint">A person's posting can override this with <code>:r</code> or <code>:w</code>.</div></div>`;
  }

  modal({
    title: (row ? "Edit " : "New ") + cfg.noun,
    body:
      `<div class="frow">` +
        `<div class="field"><label>Key *</label><input class="inp" id="eoKey" value="${esc(key)}" ${row ? "disabled" : ""} placeholder="${esc(cfg.ph)}" autocapitalize="none" spellcheck="false">` +
          `<div class="hint">Lowercase, no spaces. It is what appears in a posting.</div></div>` +
        `<div class="field"><label>Label</label><input class="inp" id="eoLabel" value="${esc(d.label)}" placeholder="${esc(cfg.phl)}"></div>` +
      `</div>` +
      extra +
      `<div class="frow">` +
        `<div class="field"><label>Colour</label><input class="inp" id="eoColour" value="${esc(d.colour)}"></div>` +
        `<div class="field"><label>Order</label><input class="inp" id="eoOrder" type="number" value="${esc(d.order)}"></div>` +
      `</div>` +
      `<div class="field"><div class="swatches" id="eoSwatch">` +
        STAGE_COLOURS.map(c => `<button type="button" class="swatch" data-c="${c}" style="background:${c};width:22px;height:22px"></button>`).join("") +
      `</div></div>`,
    after: () => {
      $("eoSwatch").onclick = e => {
        const b = e.target.closest("button[data-c]"); if (!b) return;
        $("eoColour").value = b.dataset.c;
      };
      modalSave(async () => {
        const record = {
          label: $("eoLabel").value.trim(),
          colour: $("eoColour").value.trim(),
          order: Number($("eoOrder").value) || 0
        };
        record[cfg.col] = row ? key : $("eoKey").value.trim().toLowerCase();
        if (!record[cfg.col]) throw new Error("A key is required.");
        if (kind === "Teams") record.dept = $("eoDept").value;
        if (kind === "Positions") {
          record.rank = Number($("eoRank").value) || 10;
          record.acts = Number($("eoActs").value) || record.rank;
          record.access = $("eoAccess").value;
          if (record.acts < record.rank) throw new Error("Acting rank cannot be below their own rank.");
        }
        await API.saveOrg(kind, record);
        closeModal();
        toast(cfg.noun.charAt(0).toUpperCase() + cfg.noun.slice(1) + " saved", "ok");
        await reload(); await loadAdmin();
      });
    },
    onDelete: row ? async () => {
      const used = state.data.people.filter(p => (p.posts || []).some(q => q[cfg.col] === key)).length;
      if (!confirm(used
        ? `${used} person/people are posted to "${d.label}". Remove it anyway? Their postings stop matching.`
        : `Remove the ${cfg.noun} "${d.label}"?`)) return;
      try {
        const rec = { remove: true };
        rec[cfg.col] = key;
        await API.saveOrg(kind, rec);
        closeModal(); toast("Removed", "ok");
        await reload(); await loadAdmin();
      } catch (err) { $("modalErr").textContent = err.message; }
    } : null
  });
}

function editTag(row) {
  const d = row || { tag: "", label: "", colour: STAGE_COLOURS[6], order: state.data.tags.length };
  modal({
    title: row ? "Edit tag" : "New tag",
    body:
      `<div class="frow">` +
        `<div class="field"><label>Key *</label><input class="inp" id="atKey" value="${esc(d.tag)}" ${row ? "disabled" : ""} placeholder="sales" autocapitalize="none" spellcheck="false"></div>` +
        `<div class="field"><label>Label</label><input class="inp" id="atLabel" value="${esc(d.label)}" placeholder="Sales"></div>` +
      `</div>` +
      `<div class="frow">` +
        `<div class="field"><label>Colour</label><input class="inp" id="atColour" value="${esc(d.colour)}"></div>` +
        `<div class="field"><label>Order</label><input class="inp" id="atOrder" type="number" value="${esc(d.order)}"></div>` +
      `</div>` +
      `<div class="field"><div class="swatches" id="atSwatch">` +
        STAGE_COLOURS.map(c => `<button class="swatch" data-c="${c}" style="background:${c};width:22px;height:22px"></button>`).join("") +
      `</div><div class="hint">The key goes in each person's tag list and on every record; the label is only what is drawn.</div></div>`,
    after: () => {
      $("atSwatch").onclick = e => {
        const b = e.target.closest("button[data-c]"); if (!b) return;
        $("atColour").value = b.dataset.c;
      };
      modalSave(async () => {
        const record = {
          tag: row ? row.tag : $("atKey").value.trim().toLowerCase(),
          label: $("atLabel").value.trim(), colour: $("atColour").value.trim(),
          order: Number($("atOrder").value) || 0
        };
        if (!record.tag) throw new Error("A key is required.");
        await API.saveTag(record);
        closeModal(); toast("Tag saved", "ok");
        await reload();
      });
    },
    onDelete: row ? async () => {
      if (!confirm(`Remove the tag "${row.tag}" from the catalogue? Records keep it until you edit them.`)) return;
      try {
        await API.saveTag({ tag: row.tag, remove: true });
        closeModal(); toast("Tag removed", "ok"); await reload();
      } catch (err) { $("modalErr").textContent = err.message; }
    } : null
  });
}

/* ============================================================================
   SETTINGS
   ========================================================================== */
function openSettings() {
  const seg = (id, attr, opts, cur) =>
    `<div class="seg" id="${id}">` + opts.map(o =>
      `<button data-${attr}="${esc(o.v)}" class="${String(o.v) === String(cur) ? "on" : ""}">${esc(o.l)}</button>`).join("") + `</div>`;

  modal({
    title: "Settings", hideSave: true,
    body:
      `<div class="lrow"><div><div>Theme</div><div class="ls">Dark or light</div></div><span class="spacer"></span>` +
        seg("sgTheme", "theme", [{ v: "dark", l: "Dark" }, { v: "light", l: "Light" }], document.documentElement.dataset.theme) + `</div>` +
      `<div class="lrow"><div><div>Auto refresh</div><div class="ls">Pull the sheet again on a timer</div></div><span class="spacer"></span>` +
        seg("sgAuto", "auto", [{ v: "0", l: "Off" }, { v: "120", l: "2m" }, { v: "300", l: "5m" }], state.autoSeconds) + `</div>` +
      `<div class="lrow"><div><div>Backend</div><div class="ls">${esc(API.host())}</div></div><span class="spacer"></span>` +
        `<button class="btn sm" id="sgUrl">Change</button></div>` +
      `<div class="lrow"><div><div>My password</div><div class="ls">Change it for this account</div></div><span class="spacer"></span>` +
        `<button class="btn sm" id="sgPw">Change</button></div>` +
      `<div class="lrow"><div><div>My postings</div><div class="ls" id="sgTags"></div></div></div>`,
    after: () => {
      $("sgTags").innerHTML = state.user.all ? "everything (*)"
        : (postingsHtml(state.user.postings) +
           (state.user.standsIn ? ' <span class="ro">— you can stand in above your own rank; those acts are recorded</span>' : ""));
      $("sgTheme").onclick = e => {
        const b = e.target.closest("button[data-theme]"); if (!b) return;
        document.documentElement.dataset.theme = b.dataset.theme;
        localStorage.setItem("crm.theme", b.dataset.theme);
        $("sgTheme").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
      };
      $("sgAuto").onclick = e => {
        const b = e.target.closest("button[data-auto]"); if (!b) return;
        state.autoSeconds = Number(b.dataset.auto);
        localStorage.setItem("crm.autoRefresh", String(state.autoSeconds));
        $("sgAuto").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
        armAuto();
      };
      $("sgUrl").onclick = () => { closeModal(); gate("setup"); };
      $("sgPw").onclick = changePassword;
    }
  });
}

function changePassword() {
  modal({
    title: "Change my password",
    body:
      `<div class="field"><label>Current password</label><input class="inp" id="pwOld" type="password" autocomplete="current-password"></div>` +
      `<div class="field"><label>New password</label><input class="inp" id="pwNew" type="password" autocomplete="new-password"></div>` +
      `<div class="field"><label>New password again</label><input class="inp" id="pwNew2" type="password" autocomplete="new-password"></div>`,
    after: () => modalSave(async () => {
      const a = $("pwNew").value, b = $("pwNew2").value;
      if (a.length < 4) throw new Error("At least 4 characters.");
      if (a !== b) throw new Error("The two new passwords do not match.");
      await API.changePassword($("pwOld").value, a);
      closeModal(); toast("Password changed", "ok");
    })
  });
}

/* ---------- sync indicator ---------- */
API.onChange((s, event) => {
  if (event === "auth") return gate("login", "Session ended — sign in again.");
  if (s.busy) sync("busy", "Working");
  else if (s.lastError) sync("err", "Failed");
  else if (s.lastSync) sync("ok", "Synced");
});
