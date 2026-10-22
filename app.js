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
  data: { companies: [], contacts: [], deals: [], tasks: [], flows: [], flowlog: [], time: [], tags: [], badges: [], lists: {}, people: [] },
  running: null,
  users: [],
  view: "dash",
  scope: localStorage.getItem("crm.scope") || "",     // a tag, or "" for all
  q: "",
  filters: {},
  sort: {},
  mode: { tasks: "grid", deals: "board" },
  flowSel: null,
  flowDraft: null,
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
function canWriteTag(tag) {
  if (!state.user) return false;
  return state.user.all || (state.user.write || []).indexOf(lc(tag)) >= 0;
}
const myWritableTags = () =>
  state.user && state.user.all ? state.data.tags.map(t => t.tag) : state.data.tags.map(t => t.tag).filter(canWriteTag);

function listMeta(type, value) {
  return (state.data.lists[type] || []).find(o => lc(o.value) === lc(value)) ||
         { value, label: value, colour: "#8b98a6" };
}
function pillHtml(type, value) {
  if (!value) return '<span class="ro">—</span>';
  const m = listMeta(type, value);
  return `<span class="pill" style="--c:${esc(m.colour)}"><span class="dot"></span>${esc(m.label)}</span>`;
}

/* ---------- badges: the roles a task gets handed between ---------- */
function badgeMeta(b) {
  return state.data.badges.find(x => x.badge === lc(b)) || { badge: lc(b), label: b, colour: "#8b98a6" };
}
function badgeHtml(b) {
  const m = badgeMeta(b);
  return `<span class="badge" style="--c:${esc(m.colour)}">${esc(m.label)}</span>`;
}
function badgesHtml(list) {
  const l = (list || []).filter(Boolean);
  return l.length ? `<span class="tags">${l.map(badgeHtml).join("")}</span>` : '<span class="ro">anyone</span>';
}
// everyone on the roster wearing a badge
function wearers(badge) {
  return state.data.people.filter(p => (p.badges || []).indexOf(lc(badge)) >= 0);
}
function wearersOfStep(step) {
  if (!step || !step.badges || !step.badges.length) return state.data.people.slice();
  const seen = {}, out = [];
  step.badges.forEach(b => wearers(b).forEach(p => {
    if (!seen[p.userId]) { seen[p.userId] = 1; out.push(p); }
  }));
  return out;
}
const myBadges = () => {
  const me = state.data.people.find(p => lc(p.userId) === lc(state.user.userId));
  return (me && me.badges) || [];
};

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

/* ---------- scope: the rail's tag filter ---------- */
function inScope(r) {
  if (!state.scope) return true;
  return tagsOf(r.tags).indexOf(state.scope) >= 0;
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
      { key: "tags", label: "Tags", type: "tags", full: true,
        hint: "Tags decide who else can see this. No tag means only you and admins." },
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
      { key: "tags", label: "Tags", type: "tags", full: true },
      { key: "notes", label: "Notes", type: "textarea", full: true }
    ]
  },
  Deals: {
    label: "Deal", plural: "Deals", title: r => r.title,
    fields: [
      { key: "title", label: "Deal", type: "text", required: true },
      { key: "value", label: "Value", type: "number" },
      { key: "stage", label: "Stage", type: "select", list: "stage" },
      { key: "companyId", label: "Company", type: "company" },
      { key: "contactId", label: "Contact", type: "contact" },
      { key: "closeDate", label: "Expected close", type: "date" },
      { key: "owner", label: "Owner", type: "person" },
      { key: "tags", label: "Tags", type: "tags", full: true },
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
                  { value: "Contacts", label: "Contact" }, { value: "Deals", label: "Deal" }] },
      { key: "linkId", label: "Which one", type: "link" },
      { key: "tags", label: "Tags", type: "tags", full: true,
        hint: "Tags pick the flow and the badges. They do not let anyone see the task — only the people on it can do that." },
      { key: "watchers", label: "Watchers", type: "people", full: true,
        hint: "Watchers can see the task and follow it, but cannot change it unless it is handed to them." },
      { key: "notes", label: "Notes", type: "textarea", full: true }
    ]
  }
};

function linkLabel(r) {
  if (!r.linkType || !r.linkId) return "";
  if (r.linkType === "Companies") { const c = company(r.linkId); return c ? c.name : "—"; }
  if (r.linkType === "Contacts") { const c = contact(r.linkId); return c ? c.name : "—"; }
  if (r.linkType === "Deals") { const d = byId(state.data.deals, r.linkId); return d ? d.title : "—"; }
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
    companies: r.companies || [], contacts: r.contacts || [], deals: r.deals || [],
    tasks: r.tasks || [], flows: r.flows || [], flowlog: r.flowlog || [],
    time: r.time || [], tags: r.tags || [], badges: r.badges || [],
    lists: r.lists || {}, people: r.people || []
  };
  state.running = r.running || null;
  // a scope tag that no longer exists would silently hide everything
  if (state.scope && !state.data.tags.some(t => t.tag === state.scope)) setScope("");
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
  $("btnNewBadge").onclick = () => editBadge(null);
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

  const bg = e.target.closest("[data-badgeedit]");
  if (bg) { e.stopPropagation(); return editBadge(state.data.badges.find(x => x.badge === bg.dataset.badgeedit) || null); }

  const fwd = e.target.closest("[data-forward]");
  if (fwd) { e.stopPropagation(); return forward(fwd.dataset.task, fwd.dataset.forward); }

  const unw = e.target.closest("[data-unwatch]");
  if (unw) { e.stopPropagation(); return setWatcher(unw.dataset.task, unw.dataset.unwatch, true); }
});

/* ============================================================================
   NAV
   ========================================================================== */
const NAV = [
  { group: "Work", items: [
    { id: "dash",  label: "Dashboard", ic: "▦" },
    { id: "tasks", label: "Tasks",     ic: "✓", count: () => scoped(state.data.tasks).filter(t => t.status !== "Done").length },
    { id: "flows", label: "Flows",     ic: "⇥", count: () => usableFlows().length }
  ] },
  { group: "Pipeline", items: [
    { id: "deals",     label: "Deals",     ic: "◈", count: () => scoped(state.data.deals).length },
    { id: "contacts",  label: "Contacts",  ic: "☺", count: () => scoped(state.data.contacts).length },
    { id: "companies", label: "Companies", ic: "▣", count: () => scoped(state.data.companies).length }
  ] },
  { group: "Insight", items: [ { id: "time", label: "Time", ic: "◷" } ] },
  { group: "System", items: [ { id: "admin", label: "Admin", ic: "⚙", admin: true } ] }
];

const scoped = list => list.filter(inScope);

function renderRail() {
  $("meAv").textContent = initials(state.user.name);
  $("meName").textContent = state.user.name;
  $("meRole").textContent = state.user.role === "admin" ? "Administrator"
    : state.user.all ? "All tags" : ((state.user.read || []).join(", ") || "No tags");
  $("brandSub").textContent = state.scope ? tagMeta(state.scope).label : "all departments";
  $("scopeVal").textContent = state.scope ? tagMeta(state.scope).label : "All tags";

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
  const scope = state.scope ? tagMeta(state.scope).label : "All tags";
  $("crumbs").innerHTML =
    `<span>${esc(scope)}</span><span class="sep">›</span><b>${esc(label)}</b>`;
}

function newForView() {
  const map = { tasks: "Tasks", deals: "Deals", contacts: "Contacts", companies: "Companies" };
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
  const opts = [{ tag: "", label: "All tags", colour: "#8b98a6" }].concat(state.data.tags);
  modal({
    title: "Scope",
    body: `<div class="field"><div class="hint" style="margin:0 0 10px">Narrows every view to one tag — your department, a client, a team. It does not change what you are allowed to see.</div></div>` +
          `<div class="tagpick" id="scopePick">` + opts.map(o =>
            `<button data-tag="${esc(o.tag)}" class="${state.scope === o.tag ? "on" : ""}" style="--c:${esc(o.colour)}">${esc(o.label)}</button>`
          ).join("") + `</div>`,
    hideSave: true,
    after: () => {
      $("scopePick").onclick = e => {
        const b = e.target.closest("button[data-tag]");
        if (!b) return;
        setScope(b.dataset.tag);
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
    case "deals": return renderDeals();
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
    (state.scope ? "" : sel("f_tag", [{ value: "", label: "All tags" }]
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
    { h: "Tags", get: r => tagsHtml(r.tags) },
    { h: "Logged", cls: "num", get: r => fmtMins(taskMinutes(r.id)) },
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
      (tagsOf(f.tags).length ? ` ${tagsOf(f.tags).map(tagHtml).join("")}` : "") + `</div>`;
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
    id: f.id, name: f.name, tags: f.tags, description: f.description,
    active: f.active !== false, stages: flowStages(f), _canWrite: f._canWrite
  }));
}
function dirty() {
  const f = flowOf(state.flowSel);
  if (!f || !state.flowDraft) return false;
  const a = JSON.stringify({ n: f.name, t: tagsOf(f.tags).join(","), d: f.description, a: f.active !== false, s: flowStages(f) });
  const d = state.flowDraft;
  const b = JSON.stringify({ n: d.name, t: tagsOf(d.tags).join(","), d: d.description, a: d.active, s: d.stages });
  return a !== b;
}

function newFlow() {
  const mine = myWritableTags();
  if (!mine.length) { toast("You need a writable tag before you can own a flow.", "err"); return; }
  modal({
    title: "New flow",
    body: `<div class="field"><label>Name</label><input class="inp" id="nfName" placeholder="Client request"></div>` +
          `<div class="field"><label>Tags</label><div class="tagpick" id="nfTags"></div>` +
          `<div class="hint">Who the flow belongs to. Only people with one of these tags will see it.</div></div>` +
          `<div class="field"><label>Start from</label>` +
          sel("nfTemplate", [
            { value: "standard", label: "A five-step delivery flow (you can edit it)" },
            { value: "blank", label: "Blank — I'll build the stages myself" }
          ], "standard") + `</div>`,
    after: () => {
      const chosen = [mine[0]];
      const paintTags = () => {
        $("nfTags").innerHTML = state.data.tags.map(t => {
          const on = chosen.indexOf(t.tag) >= 0;
          return `<button data-t="${esc(t.tag)}" class="${on ? "on" : ""}" style="--c:${esc(t.colour)}"` +
                 `${canWriteTag(t.tag) ? "" : " disabled"}>${esc(t.label)}</button>`;
        }).join("");
      };
      paintTags();
      $("nfTags").onclick = e => {
        const b = e.target.closest("button[data-t]"); if (!b) return;
        const i = chosen.indexOf(b.dataset.t);
        if (i >= 0) chosen.splice(i, 1); else chosen.push(b.dataset.t);
        paintTags();
      };
      $("nfName").focus();
      modalSave(async () => {
        const name = $("nfName").value.trim();
        if (!name) throw new Error("Give the flow a name.");
        if (!chosen.length) throw new Error("Pick at least one tag you can write to.");
        const b = k => state.data.badges.some(x => x.badge === k) ? [k] : [];
        const stages = $("nfTemplate").value === "blank" ? [
          { key: "step-1", name: "Raised", colour: STAGE_COLOURS[1], badges: [], next: [],
            slaHours: 4, entry: true, approval: false, terminal: false }
        ] : [
          { key: "raised",  name: "Raised",    colour: "#60a5fa", badges: b("csm").concat(b("dm"), b("ops")), next: ["triage"], slaHours: 4,  entry: true },
          { key: "triage",  name: "Triage",    colour: "#2dd4bf", badges: b("cro-manager"), next: ["work", "review"], slaHours: 8 },
          { key: "work",    name: "In hand",   colour: "#fbbf24", badges: b("cro-sd").concat(b("cro-gd"), b("cro-cs")), next: ["review"], slaHours: 48 },
          { key: "review",  name: "Review",    colour: "#a78bfa", badges: b("cro-manager"), next: ["work", "done"], slaHours: 12, approval: true },
          { key: "done",    name: "Delivered", colour: "#34d399", badges: [], next: [], slaHours: 0, terminal: true }
        ];
        const r = await API.save("Flows", { name, tags: chosen.join(", "), description: "", active: true, stages });
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
       <div><div class="mk">Tags — who this flow belongs to</div><div class="tagpick" id="fTags"></div></div>
       <div><div class="mk">On this flow</div><div style="font-size:12.5px">${
         state.data.tasks.filter(t => t.flowId === d.id).length} task(s)</div></div>
     </div>
     <div class="mk" style="font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:10px">Stages</div>
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
  const box = $("fTags");
  if (!box) return;
  const chosen = tagsOf(d.tags);
  box.innerHTML = state.data.tags.map(t => {
    const on = chosen.indexOf(t.tag) >= 0;
    return `<button data-t="${esc(t.tag)}" class="${on ? "on" : ""}" style="--c:${esc(t.colour)}"` +
           `${(!d._canWrite || (!canWriteTag(t.tag) && !on)) ? " disabled" : ""}>${esc(t.label)}</button>`;
  }).join("") || '<span class="ro">no tags defined</span>';
  box.onclick = e => {
    const b = e.target.closest("button[data-t]"); if (!b) return;
    const list = tagsOf(d.tags);
    const i = list.indexOf(b.dataset.t);
    if (i >= 0) list.splice(i, 1); else list.push(b.dataset.t);
    d.tags = list.join(", ");
    paintFlowTags();
  };
}

function paintChain() {
  const d = state.flowDraft;
  const chain = $("fChain");
  if (!chain) return;
  const ro = !d._canWrite;
  chain.innerHTML = "";

  d.stages.forEach((s, i) => {
    if (i > 0) chain.appendChild(linkNode(i, ro));
    chain.appendChild(stageNode(s, i, ro));
  });
  if (!ro) {
    const tail = el("div", "tail");
    const add = el("button", "btn sm", "+ Stage");
    add.onclick = () => { addStage(d.stages.length); };
    tail.appendChild(add);
    chain.appendChild(tail);
  }
  if (!d.stages.length && ro) chain.innerHTML = '<div class="ro">no stages</div>';
}

function linkNode(index, ro) {
  const link = el("div", "link");
  if (!ro) {
    const add = el("button", "add", "+");
    add.title = "Insert a stage here";
    add.onclick = () => addStage(index);
    link.appendChild(add);
  }
  return link;
}

function stageNode(s, i, ro) {
  const d = state.flowDraft;
  const card = el("div", "stagecard");
  card.style.setProperty("--c", s.colour);
  card.draggable = !ro;

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

    `<div class="sgroup"><div class="sgl">Handled by</div><div class="tagpick tiny" data-badges>` +
      (state.data.badges.length ? state.data.badges.map(b => {
        const on = (s.badges || []).indexOf(b.badge) >= 0;
        return `<button data-b="${esc(b.badge)}" class="${on ? "on" : ""}" style="--c:${esc(b.colour)}" ${ro ? "disabled" : ""}>${esc(b.label)}</button>`;
      }).join("") : '<span class="ro">no badges yet</span>') +
    `</div></div>` +

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
  card.querySelector("[data-badges]").onclick = e => {
    const b = e.target.closest("button[data-b]"); if (!b) return;
    s.badges = s.badges || [];
    const at = s.badges.indexOf(b.dataset.b);
    if (at >= 0) s.badges.splice(at, 1); else s.badges.push(b.dataset.b);
    paintChain();
  };
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

  card.addEventListener("dragstart", ev => { ev.dataTransfer.setData("text/plain", String(i)); card.classList.add("drag"); });
  card.addEventListener("dragend", () => card.classList.remove("drag"));
  card.addEventListener("dragover", ev => ev.preventDefault());
  card.addEventListener("drop", ev => {
    ev.preventDefault();
    const from = Number(ev.dataTransfer.getData("text/plain"));
    if (!isNaN(from)) move(from, i);
  });
  return card;
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
    badges: [], next: [], slaHours: 24, entry: false, approval: false, terminal: false
  };
  d.stages.splice(at, 0, stage);
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
      id: d.id, name: d.name.trim(), tags: d.tags, description: d.description,
      active: d.active, stages: d.stages.map(s => ({
        key: s.key, name: s.name, colour: s.colour, slaHours: s.slaHours,
        badges: s.badges || [], next: s.next || [],
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
  const pool = wearersOfStep(step);

  modal({
    title: "Hand over to " + step.name,
    saveLabel: "Send",
    body:
      `<div class="field"><label>Who takes it on</label><select class="inp" id="hoWho">` +
      pool.map(p => `<option value="${esc(p.userId)}">${esc(p.name)}</option>`).join("") +
      `</select><div class="hint">${badgesHtml(step.badges)} — only people wearing this can be handed the step.</div></div>` +
      `<div class="field"><label>Note (optional)</label><input class="inp" id="hoNote" placeholder="What they need to know"></div>`,
    after: () => modalSave(async () => {
      const who = $("hoWho").value;
      const ok = await forward(taskId, stepKey, who, $("hoNote").value.trim());
      if (ok) closeModal();
    })
  });
}

/* ============================================================================
   DEALS
   ========================================================================== */
function dealRows() {
  const tag = filt("deals", "tag");
  const who = filt("deals", "who");
  return scoped(state.data.deals).filter(d => {
    if (tag && tagsOf(d.tags).indexOf(tag) < 0) return false;
    if (who === "@me") { if (lc(d.owner) !== lc(state.user.userId)) return false; }
    else if (who && lc(d.owner) !== lc(who)) return false;
    const c = company(d.companyId);
    return hits(d, ["title", "notes", "stage"]) || (!!state.q && !!c && lc(c.name).indexOf(lc(state.q)) >= 0);
  });
}

function renderDeals() {
  const mode = state.mode.deals;
  setBar("Deals", null,
    sel("f_who", peopleOpts("Any owner"), filt("deals", "who")) +
    (state.scope ? "" : sel("f_tag", [{ value: "", label: "All tags" }]
      .concat(state.data.tags.map(t => ({ value: t.tag, label: t.label }))), filt("deals", "tag"))) +
    `<span class="spacer"></span>` +
    `<div class="seg" id="dealMode">
       <button data-m="board" class="${mode === "board" ? "on" : ""}">Board</button>
       <button data-m="grid" class="${mode === "grid" ? "on" : ""}">Grid</button>
     </div>`);
  ["who", "tag"].forEach(k => onFilt("deals", k));
  $("dealMode").onclick = e => {
    const b = e.target.closest("button[data-m]"); if (!b) return;
    state.mode.deals = b.dataset.m; renderDeals();
  };

  const rows = dealRows();
  $("dealGridWrap").style.display = mode === "grid" ? "block" : "none";
  $("dealBoard").style.display = mode === "board" ? "flex" : "none";
  if (mode === "board") renderDealBoard(rows); else renderDealGrid(rows);

  const open = rows.filter(d => d.stage !== "Won" && d.stage !== "Lost");
  const won = rows.filter(d => d.stage === "Won").reduce((s, d) => s + (Number(d.value) || 0), 0);
  statusCount(`${open.length} live · ${money(open.reduce((s, d) => s + (Number(d.value) || 0), 0))} open · ${money(won)} won`);
}

function renderDealBoard(rows) {
  const wrap = $("dealBoard");
  wrap.innerHTML = "";
  (state.data.lists.stage || []).forEach(st => {
    const mine = rows.filter(d => lc(d.stage) === lc(st.value));
    const col = el("div", "bcol");
    const sum = mine.reduce((s, d) => s + (Number(d.value) || 0), 0);
    col.appendChild(el("div", "bchead",
      `<span class="pill" style="--c:${esc(st.colour)}"><span class="dot"></span>${esc(st.label)}</span>` +
      `<span class="spacer"></span><span class="bs">${mine.length} · ${money(sum)}</span>`));
    const body = el("div", "bcbody");
    if (!mine.length) body.appendChild(el("div", "bempty", "—"));
    mine.forEach(d => {
      const c = company(d.companyId);
      const card = el("div", "bcard");
      card.draggable = !!d._canWrite;
      card.innerHTML = `<div class="bt">${esc(d.title)}</div><div class="bm">` +
        (d.value ? `<span class="bv">${money(d.value)}</span>` : "") +
        (c ? `<span>${esc(c.name)}</span>` : "") +
        (d.closeDate ? `<span>${esc(fmtDay(d.closeDate))}</span>` : "") + `</div>`;
      card.onclick = () => openDrawer("Deals", d.id);
      card.addEventListener("dragstart", ev => { ev.dataTransfer.setData("text/plain", d.id); card.classList.add("drag"); });
      card.addEventListener("dragend", () => card.classList.remove("drag"));
      body.appendChild(card);
    });
    col.appendChild(body);
    col.addEventListener("dragover", ev => { ev.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", async ev => {
      ev.preventDefault(); col.classList.remove("over");
      const d = byId(state.data.deals, ev.dataTransfer.getData("text/plain"));
      if (d && lc(d.stage) !== lc(st.value)) await patch("Deals", d, { stage: st.value });
    });
    wrap.appendChild(col);
  });
}

function renderDealGrid(rows) {
  rows = sortRows(rows, "deals", "title");
  grid($("gDeals"), [
    { h: "Deal", cls: "wrap", sort: "title", get: r => {
        const c = company(r.companyId), p = contact(r.contactId);
        return `<div class="prime">${esc(r.title)}</div>` +
               `<div class="sub">${esc([c && c.name, p && p.name].filter(Boolean).join(" · ")) || "—"}</div>`;
      } },
    { h: "Stage", sort: "stage", get: r => pillHtml("stage", r.stage) },
    { h: "Value", cls: "num", sort: "value", get: r => money(r.value) },
    { h: "Close", sort: "closeDate", get: r => esc(fmtDay(r.closeDate)) || "—" },
    { h: "Owner", sort: "owner", get: r => whoHtml(r.owner) },
    { h: "Tags", get: r => tagsHtml(r.tags) },
    { h: "", cls: "act", get: r => `<span class="rowacts">${editBtn("Deals", r)}</span>` }
  ], rows, {
    key: "deals", blankTitle: "No deals", blank: "Create one with + New.",
    onRow: r => openDrawer("Deals", r.id)
  });
}

/* ============================================================================
   CONTACTS / COMPANIES
   ========================================================================== */
function renderContacts() {
  setBar("Contacts", null,
    sel("f_status", listOpts("contactStatus", "Any status"), filt("contacts", "status")) +
    (state.scope ? "" : sel("f_tag", [{ value: "", label: "All tags" }]
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
    { h: "Tags", get: r => tagsHtml(r.tags) },
    { h: "", cls: "act", get: r => `<span class="rowacts">${editBtn("Contacts", r)}</span>` }
  ], rows, { key: "contacts", blankTitle: "No contacts", blank: "Create one with + New.",
             onRow: r => openDrawer("Contacts", r.id) });
  statusCount(`${rows.length} contacts`);
}

function renderCompanies() {
  setBar("Companies", null,
    state.scope ? "" : sel("f_tag", [{ value: "", label: "All tags" }]
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
    { h: "Deals", cls: "num", get: r => String(state.data.deals.filter(d => d.companyId === r.id).length) },
    { h: "Owner", sort: "owner", get: r => whoHtml(r.owner) },
    { h: "Tags", get: r => tagsHtml(r.tags) },
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
  const deals = scoped(state.data.deals);
  const live = deals.filter(d => d.stage !== "Won" && d.stage !== "Lost");
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
    ["Open pipeline", money(live.reduce((s, d) => s + (Number(d.value) || 0), 0)), `${live.length} live deals`],
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

  const stages = state.data.lists.stage || [];
  const pipeRows = stages.filter(s => s.value !== "Lost").map(s => {
    const list = deals.filter(d => lc(d.stage) === lc(s.value));
    return { s, n: list.length, v: list.reduce((a, d) => a + (Number(d.value) || 0), 0) };
  });
  const maxV = Math.max(1, ...pipeRows.map(r => r.v));
  const pipeHtml = pipeRows.length ? `<div class="bars">` + pipeRows.map(r =>
    `<div class="bar"><div class="bl"><span>${esc(r.s.label)} <span class="ls">(${r.n})</span></span><b>${money(r.v)}</b></div>` +
    `<div class="btrack"><span style="width:${Math.round(r.v / maxV * 100)}%;background:${esc(r.s.colour)}"></span></div></div>`).join("") + `</div>`
    : `<div class="nothing">No deals yet.</div>`;

  $("dashGrid").innerHTML =
    `<div class="kpis">${kpis}</div>` +
    panel("My tasks", mine.length ? mine.length + " open" : "", myList) +
    panel("Stage load", "open work by flow stage", loadHtml) +
    panel("Past stage target", stuck.length ? stuck.length + " waiting" : "", stuckList) +
    panel("Pipeline", money(pipeRows.reduce((a, r) => a + r.v, 0)), pipeHtml);
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
    const t = taskOf(taskId);
    toast("Timer started" + (t ? " · " + t.title : ""), "ok");
    paint();
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
  if (entity === "Deals") {
    badges.push(pillHtml("stage", row.stage));
    if (row.value) badges.push(`<b style="color:var(--accent)">${money(row.value)}</b>`);
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
            badgesHtml(cur.badges) + `</div>` +
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
              const pool = wearersOfStep(s);
              const who = s.badges.length
                ? (pool.length === 1 ? personName(pool[0].userId) : pool.length + " people")
                : "anyone";
              return `<button class="fwdbtn" style="--c:${esc(s.colour)}" data-forward="${esc(s.key)}" data-task="${esc(row.id)}">` +
                     `<span class="fn">${esc(s.name)} →</span>` +
                     `<span class="fb">${s.badges.map(b => esc(badgeMeta(b).label)).join(", ") || "no badge"} · ${esc(who)}</span>` +
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
                "linkType", "name", "watchers", "participants", "assignee"];
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
      const kind = { Companies: "company", Contacts: "contact", Deals: "deal" }[row.linkType] || "";
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
    const watchers = tagsOf(row.watchers);
    const parts = tagsOf(row.participants)
      .filter(p => p !== lc(row.owner) && p !== lc(row.assignee) && watchers.indexOf(p) < 0);
    const me = lc(state.user.userId);
    const canManage = row._canWrite || lc(row.owner) === me;
    html += `<div class="sect"><h4>Who can see this</h4>` +
      `<div class="lrow"><span class="ls" style="width:76px">Raised by</span>${whoHtml(row.owner)}</div>` +
      `<div class="lrow"><span class="ls" style="width:76px">Holding it</span>${row.assignee ? whoHtml(row.assignee) : '<span class="ro">nobody</span>'}</div>` +
      `<div class="lrow"><span class="ls" style="width:76px">Watchers</span>` +
        (watchers.length
          ? `<span class="tags">` + watchers.map(w =>
              `<span class="watch">${whoHtml(w)}` +
              ((canManage || w === me) ? `<button class="x" data-unwatch="${esc(w)}" data-task="${esc(row.id)}" title="Remove">×</button>` : "") +
              `</span>`).join("") + `</span>`
          : '<span class="ro">none</span>') +
        `<span class="spacer"></span>` +
        `<button class="btn xs" id="btnAddWatcher">+ Add</button></div>` +
      (parts.length
        ? `<div class="lrow"><span class="ls" style="width:76px">Has held it</span><span class="tags">` +
          parts.map(p => whoHtml(p)).join("") + `</span></div>`
        : "") +
      `<div class="ls" style="margin-top:7px">Nobody else can see this task — tags do not open it up.</div>` +
      `</div>`;
  }

  html += `<div class="sect"><h4>Tags</h4>${tagsHtml(row.tags)}</div>`;
  if (row.notes) html += `<div class="sect"><h4>Notes</h4><div class="note">${esc(row.notes)}</div></div>`;

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
      const deals = state.data.deals.filter(d => d.companyId === row.id);
      if (people.length) html += `<div class="sect"><h4>Contacts</h4>` + people.map(c =>
        `<div class="lrow"><span class="lt">${esc(c.name)}</span><span class="ls">${esc(c.title)}</span>` +
        `<span class="spacer"></span>${pillHtml("contactStatus", c.status)}</div>`).join("") + `</div>`;
      if (deals.length) html += `<div class="sect"><h4>Deals</h4>` + deals.map(d =>
        `<div class="lrow"><span class="lt">${esc(d.title)}</span><span class="spacer"></span>` +
        `<span class="ls">${money(d.value)}</span>${pillHtml("stage", d.stage)}</div>`).join("") + `</div>`;
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

  if ($("btnAddWatcher")) $("btnAddWatcher").onclick = () => addWatcher(row.id);

  $("drawer").classList.add("on");
  $("scrim").classList.add("on");
}

async function setWatcher(taskId, who, remove) {
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
    toast(remove ? "Watcher removed" : "Watcher added", "ok");
    paint();
    if ($("drawer").classList.contains("on")) openDrawer("Tasks", taskId);
  } catch (err) { toast(err.message, "err"); }
}

function addWatcher(taskId) {
  const t = taskOf(taskId);
  const on = tagsOf(t.watchers).concat([lc(t.owner), lc(t.assignee)]);
  const pool = state.data.people.filter(p => on.indexOf(lc(p.userId)) < 0);
  if (!pool.length) { toast("Everyone is already on this task.", "err"); return; }
  modal({
    title: "Add a watcher",
    saveLabel: "Add",
    body: `<div class="field"><label>Who</label><select class="inp" id="awWho">` +
      pool.map(p => `<option value="${esc(p.userId)}">${esc(p.name)}${p.badges && p.badges.length ? " — " + esc(p.badges.map(b => badgeMeta(b).label).join(", ")) : ""}</option>`).join("") +
      `</select><div class="hint">A watcher can see the task and follow where it goes, but cannot change it unless it is handed to them.</div></div>`,
    after: () => modalSave(async () => {
      await setWatcher(taskId, $("awWho").value, false);
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
  if (!row) {
    draft.owner = state.user.userId;
    if (entity === "Tasks") {
      draft.assignee = state.user.userId;
      draft.status = ((state.data.lists.taskStatus || [{}])[0] || {}).value || "Todo";
      draft.priority = "Normal";
    }
    if (entity === "Deals") draft.stage = ((state.data.lists.stage || [{}])[0] || {}).value || "Lead";
    if (entity === "Contacts") draft.status = ((state.data.lists.contactStatus || [{}])[0] || {}).value || "";
    // a new record should not be born private
    const mine = myWritableTags();
    const preferred = state.scope && canWriteTag(state.scope) ? state.scope : mine[0];
    if (preferred) draft.tags = preferred;
  }
  editing = { entity, id: row ? row.id : "", draft, wasFlow: row ? row.flowId : "" };

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
                : t === "Deals" ? state.data.deals : [];
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
    if (f.key === "linkType" || f.key === "companyId") paintFields();
  });
  wrap.appendChild(node);
  if (f.hint) wrap.appendChild(el("div", "hint", esc(f.hint)));
  return wrap;
}

async function saveEditor() {
  const spec = SPEC[editing.entity];
  for (const f of spec.fields) {
    if (f.required && !String(editing.draft[f.key] || "").trim()) throw new Error(f.label + " is required.");
  }
  const record = Object.assign({}, editing.draft);
  if (editing.id) record.id = editing.id;
  // moving off a flow, or onto a different one, drops the old stage
  if (editing.entity === "Tasks" && record.flowId !== editing.wasFlow) record.stage = "";

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
  setBar("Admin", `${state.users.length} people · ${state.data.badges.length} badges · ${state.data.tags.length} tags`, "");
  grid($("gUsers"), [
    { h: "User ID", get: r => `<code>${esc(r.userId)}</code>` },
    { h: "Name", get: r => esc(r.name) || "—" },
    { h: "Email", get: r => esc(r.email) || "—" },
    { h: "Role", get: r => r.role === "admin" ? `<span class="pill" style="--c:#2dd4bf"><span class="dot"></span>admin</span>` : "user" },
    { h: "Tags", cls: "wrap", get: r => {
        const list = String(r.tags || "").split(/[,;]/).map(s => s.trim()).filter(Boolean);
        if (!list.length) return '<span class="ro">none</span>';
        return `<span class="tags">` + list.map(t => {
          const ro = /:r$/.test(t), base = t.replace(/:r$/, "");
          if (base === "*") return `<span class="tag" style="--c:#2dd4bf">everything</span>`;
          return tagHtml(base) + (ro ? ' <span class="ro">read</span>' : "");
        }).join(" ") + `</span>`;
      } },
    { h: "Badges", cls: "wrap", get: r => {
        const list = tagsOf(r.badges);
        return list.length ? `<span class="tags">${list.map(badgeHtml).join("")}</span>` : '<span class="ro">none</span>';
      } },
    { h: "Active", get: r => r.active
        ? `<span class="pill" style="--c:#34d399"><span class="dot"></span>on</span>`
        : `<span class="pill" style="--c:#f87171"><span class="dot"></span>off</span>` },
    { h: "", cls: "act", get: r => `<span class="rowacts"><button class="btn xs" data-user="${esc(r.userId)}">Edit</button></span>` }
  ], state.users, { key: "users", blankTitle: "No users" });

  grid($("gBadges"), [
    { h: "Badge", get: r => badgeHtml(r.badge) },
    { h: "Key", get: r => `<code>${esc(r.badge)}</code>` },
    { h: "Label", get: r => esc(r.label) },
    { h: "Worn by", cls: "wrap", get: r => {
        const who = wearers(r.badge);
        return who.length ? who.map(p => esc(p.name)).join(", ") : '<span class="ro">nobody yet</span>';
      } },
    { h: "Steps", cls: "num", get: r => String(state.data.flows.reduce((s, f) =>
        s + flowStages(f).filter(st => (st.badges || []).indexOf(r.badge) >= 0).length, 0)) },
    { h: "", cls: "act", get: r => `<span class="rowacts"><button class="btn xs" data-badgeedit="${esc(r.badge)}">Edit</button></span>` }
  ], state.data.badges, {
    key: "badges", blankTitle: "No badges",
    blank: "Badges are the desks a task passes between — CSM, CRO Manager, CRO SD. Add one with + Badge."
  });

  grid($("gTags"), [
    { h: "Tag", get: r => tagHtml(r.tag) },
    { h: "Key", get: r => `<code>${esc(r.tag)}</code>` },
    { h: "Label", get: r => esc(r.label) },
    { h: "Colour", get: r => `<code>${esc(r.colour)}</code>` },
    { h: "Flows", cls: "num", get: r => String(state.data.flows.filter(f => tagsOf(f.tags).indexOf(r.tag) >= 0).length) },
    { h: "Records", cls: "num", get: r => String(["companies", "contacts", "deals", "tasks"]
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
      `<div class="field"><label>Tags</label><input class="inp" id="auTags" value="${esc(d.tags)}" placeholder="sales, support:r">` +
        `<div class="hint"><code>tag</code> read + write · <code>tag:r</code> read only · <code>*</code> everything.<br>` +
        `Known tags: ${state.data.tags.map(t => `<code>${esc(t.tag)}</code>`).join(", ") || "none yet"}</div></div>` +
      `<div class="field"><label>Badges</label><div class="tagpick" id="auBadges"></div>` +
        `<div class="hint">The desks this person staffs. A flow step addressed to a badge can only be handed to someone wearing it.</div></div>` +
      `<div class="frow">` +
        `<div class="field"><label>${row ? "New password (blank = leave it)" : "Password *"}</label><input class="inp" id="auPw" type="text" autocomplete="off"></div>` +
        `<div class="field"><label>Active</label><select class="inp" id="auActive">` +
          `<option value="1"${d.active ? " selected" : ""}>On</option><option value="0"${!d.active ? " selected" : ""}>Off</option></select></div>` +
      `</div>`,
    after: () => {
      const picked = tagsOf(d.badges);
      const paintBadges = () => {
        $("auBadges").innerHTML = state.data.badges.length
          ? state.data.badges.map(b =>
              `<button type="button" data-b="${esc(b.badge)}" class="${picked.indexOf(b.badge) >= 0 ? "on" : ""}" ` +
              `style="--c:${esc(b.colour)}">${esc(b.label)}</button>`).join("")
          : '<span class="ro">no badges defined yet</span>';
      };
      paintBadges();
      $("auBadges").onclick = e => {
        const b = e.target.closest("button[data-b]"); if (!b) return;
        const i = picked.indexOf(b.dataset.b);
        if (i >= 0) picked.splice(i, 1); else picked.push(b.dataset.b);
        paintBadges();
      };
      modalSave(async () => {
      const record = {
        userId: row ? row.userId : $("auId").value.trim(),
        name: $("auName").value.trim(), email: $("auEmail").value.trim(),
        role: $("auRole").value, tags: $("auTags").value, badges: picked.join(", "),
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

function editBadge(row) {
  const d = row || { badge: "", label: "", colour: STAGE_COLOURS[6], order: state.data.badges.length };
  modal({
    title: row ? "Edit badge" : "New badge",
    body:
      `<div class="frow">` +
        `<div class="field"><label>Key *</label><input class="inp" id="abKey" value="${esc(d.badge)}" ${row ? "disabled" : ""} placeholder="cro-sd" autocapitalize="none" spellcheck="false"></div>` +
        `<div class="field"><label>Label</label><input class="inp" id="abLabel" value="${esc(d.label)}" placeholder="CRO SD"></div>` +
      `</div>` +
      `<div class="frow">` +
        `<div class="field"><label>Colour</label><input class="inp" id="abColour" value="${esc(d.colour)}"></div>` +
        `<div class="field"><label>Order</label><input class="inp" id="abOrder" type="number" value="${esc(d.order)}"></div>` +
      `</div>` +
      `<div class="field"><div class="swatches" id="abSwatch">` +
        STAGE_COLOURS.map(c => `<button type="button" class="swatch" data-c="${c}" style="background:${c};width:22px;height:22px"></button>`).join("") +
      `</div><div class="hint">A badge is a desk, not a person: give it to everyone who staffs that desk in Admin ▸ People.</div></div>` +
      (row ? `<div class="hint">Worn by ${wearers(row.badge).map(p => esc(p.name)).join(", ") || "nobody yet"}.</div>` : ""),
    after: () => {
      $("abSwatch").onclick = e => {
        const b = e.target.closest("button[data-c]"); if (!b) return;
        $("abColour").value = b.dataset.c;
      };
      modalSave(async () => {
        const record = {
          badge: row ? row.badge : $("abKey").value.trim().toLowerCase(),
          label: $("abLabel").value.trim(), colour: $("abColour").value.trim(),
          order: Number($("abOrder").value) || 0
        };
        if (!record.badge) throw new Error("A key is required.");
        await API.saveBadge(record);
        closeModal(); toast("Badge saved", "ok");
        await reload(); await loadAdmin();
      });
    },
    onDelete: row ? async () => {
      const used = state.data.flows.reduce((s, f) =>
        s + flowStages(f).filter(st => (st.badges || []).indexOf(row.badge) >= 0).length, 0);
      if (!confirm(used
        ? `${used} flow step(s) are addressed to "${row.label}". Remove the badge anyway? Those steps will have nobody to hand to.`
        : `Remove the badge "${row.label}"?`)) return;
      try {
        await API.saveBadge({ badge: row.badge, remove: true });
        closeModal(); toast("Badge removed", "ok");
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
      `<div class="lrow"><div><div>My tags</div><div class="ls" id="sgTags"></div></div></div>`,
    after: () => {
      $("sgTags").innerHTML = state.user.all ? "everything (*)"
        : ((state.user.read || []).map(t => tagHtml(t) + (canWriteTag(t) ? "" : ' <span class="ro">read</span>')).join(" ") || "none");
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
