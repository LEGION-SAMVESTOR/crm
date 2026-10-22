/**
 * CRM — Google Sheets backend
 * ---------------------------------------------------------------------------
 * Paste this into the Apps Script editor of the backend spreadsheet
 * (Extensions > Apps Script), then deploy it as a Web app:
 *
 *    Deploy > New deployment > Web app
 *      Execute as:      Me
 *      Who has access:  Anyone
 *
 * Copy the /exec URL and paste it into the CRM's setup screen once per device.
 *
 * Tabs this script owns (all created for you by the setup menu item):
 *    Users      — who can sign in, the tags they hold, and the badges they wear
 *    Sessions   — issued login tokens (housekeeping, safe to clear any time)
 *    Tags       — the tag catalogue: label + colour per tag
 *    Badges     — the role catalogue: CSM, CRO Manager, CRO SD, …
 *    Lists      — pipeline stages, statuses, priorities
 *    Companies  — accounts
 *    Contacts   — people, each optionally attached to a company
 *    Deals      — pipeline
 *    Tasks      — work items, optionally attached to any of the above
 *    Flows      — the routing maps you draw in the Flow builder
 *    FlowLog    — one row per desk a task passed through: who held it, how long
 *    TimeLog    — one row per timer session against a task
 *    Activity   — a plain audit trail of who changed what
 *
 * ACCESS MODEL — everything hangs off tags.
 *   A person's `tags` cell is a comma separated list, e.g.  aujjessa, razzai:r
 *     tag          full read + write on records carrying that tag
 *     tag:r        read only on records carrying that tag
 *     *            everything, read + write
 *   A record is visible when its tags overlap the person's tags, or when they
 *   own it. A record with no tags at all is private to its owner and to admins.
 *   `role` = admin also unlocks the Admin view (users, tags, lists).
 *
 * TASKS ARE DIFFERENT — a task is not visible by tag. It is visible only to:
 *     the person who created it,
 *     anyone on its watchers list,
 *     whoever it is assigned to now,
 *     and anyone who has held it at some point (its participants),
 *   plus admins. Tags on a task only decide which flow and which badges apply.
 *
 * BADGES are roles: CSM, DM, Ops, CRO Manager, CRO CS, CRO GD, CRO SD TL,
 *   CRO SD. A person wears one or more. A flow step is addressed to a badge,
 *   so forwarding a task means handing it to someone wearing that badge — the
 *   task lands in their lap and becomes visible to them.
 */

/* ========================================================================
   CONFIG
   ======================================================================== */
/* Bump this when HEAD changes and the next request will migrate the sheet by
   itself — new tabs created, new columns appended, nothing already there
   moved. Nobody has to run anything. */
var SCHEMA_VERSION = "2026-10-22.1";

var SESSION_DAYS = 30;     // how long a login lasts
var TIME_DAYS    = 180;    // how much of the time log the app pulls down

var HEAD = {
  Users:     ["userId", "name", "email", "role", "tags", "badges", "password", "passwordHash", "active"],
  Sessions:  ["token", "userId", "createdAt", "expiresAt"],
  Tags:      ["tag", "label", "colour", "order"],
  Badges:    ["badge", "label", "colour", "order"],
  Lists:     ["type", "value", "label", "colour", "order"],
  Companies: ["id", "name", "owner", "tags", "website", "phone", "city", "notes", "createdAt", "updatedAt"],
  Contacts:  ["id", "name", "companyId", "title", "email", "phone", "owner", "tags", "status", "notes", "createdAt", "updatedAt"],
  Deals:     ["id", "title", "companyId", "contactId", "value", "stage", "owner", "tags", "closeDate", "notes", "createdAt", "updatedAt"],
  Tasks:     ["id", "title", "notes", "linkType", "linkId", "assignee", "owner", "tags", "status", "priority", "dueDate", "flowId", "stage", "watchers", "participants", "createdAt", "updatedAt"],
  Flows:     ["id", "name", "tags", "description", "stages", "active", "owner", "createdAt", "updatedAt"],
  FlowLog:   ["id", "taskId", "flowId", "stage", "assignee", "enteredAt", "exitedAt", "minutes", "byUser", "note"],
  TimeLog:   ["id", "taskId", "userId", "date", "start", "end", "minutes", "note", "createdAt"],
  Activity:  ["at", "userId", "entity", "entityId", "action", "detail"]
};

// the entities the generic save/remove endpoints will accept
var ENTITIES = ["Companies", "Contacts", "Deals", "Tasks", "Flows"];

var DEFAULT_TAGS = [
  ["internal", "Internal", "#5ea8ff", 0],
  ["sales",    "Sales",    "#3ddc84", 1],
  ["support",  "Support",  "#ffc24b", 2]
];

var DEFAULT_LISTS = [
  ["stage", "Lead",        "#8b98a6", 0],
  ["stage", "Qualified",   "#5ea8ff", 1],
  ["stage", "Proposal",    "#9d7bff", 2],
  ["stage", "Negotiation", "#ffc24b", 3],
  ["stage", "Won",         "#3ddc84", 4],
  ["stage", "Lost",        "#ff5c69", 5],

  ["taskStatus", "Todo",        "#ffc24b", 0],
  ["taskStatus", "In Progress", "#5ea8ff", 1],
  ["taskStatus", "Blocked",     "#ff5c69", 2],
  ["taskStatus", "Done",        "#3ddc84", 3],

  ["priority", "Low",    "#8b98a6", 0],
  ["priority", "Normal", "#5ea8ff", 1],
  ["priority", "High",   "#ffc24b", 2],
  ["priority", "Urgent", "#ff5c69", 3],

  ["contactStatus", "Prospect", "#ffc24b", 0],
  ["contactStatus", "Active",   "#5ea8ff", 1],
  ["contactStatus", "Customer", "#3ddc84", 2],
  ["contactStatus", "Churned",  "#8b98a6", 3]
];

// The roles a task gets handed between. Edit them in Admin once you are in.
var DEFAULT_BADGES = [
  ["csm",         "CSM",         "#60a5fa", 0],
  ["dm",          "DM",          "#a78bfa", 1],
  ["ops",         "Ops",         "#f472b6", 2],
  ["cro-manager", "CRO Manager", "#2dd4bf", 3],
  ["cro-cs",      "CRO CS",      "#fbbf24", 4],
  ["cro-gd",      "CRO GD",      "#f87171", 5],
  ["cro-sd-tl",   "CRO SD TL",   "#34d399", 6],
  ["cro-sd",      "CRO SD",      "#8b98a6", 7]
];

// One worked routing map so the Flow builder is not an empty room on day one.
// `badges` is who handles the step; `next` is where it may be forwarded from
// there (empty = the following step); `entry` steps are where work comes in.
var DEFAULT_FLOW = {
  name: "CRO request",
  tags: "internal",
  description: "Where a CRO request goes, desk by desk.",
  stages: [
    { key: "intake",   name: "Raised",     colour: "#60a5fa", badges: ["csm", "dm", "ops"], slaHours: 4,  entry: true,  next: ["triage"] },
    { key: "triage",   name: "Triage",     colour: "#2dd4bf", badges: ["cro-manager"],      slaHours: 8,  next: ["copy", "design", "build"] },
    { key: "copy",     name: "Copy",       colour: "#fbbf24", badges: ["cro-cs"],           slaHours: 24, next: ["design", "review"] },
    { key: "design",   name: "Design",     colour: "#f87171", badges: ["cro-gd"],           slaHours: 48, next: ["build", "review"] },
    { key: "build",    name: "Build",      colour: "#34d399", badges: ["cro-sd-tl", "cro-sd"], slaHours: 48, next: ["review"] },
    { key: "review",   name: "Review",     colour: "#a78bfa", badges: ["cro-manager"],      slaHours: 12, approval: true, next: ["copy", "design", "build", "done"] },
    { key: "done",     name: "Delivered",  colour: "#8b98a6", badges: [],                   slaHours: 0,  terminal: true }
  ]
};

/* ========================================================================
   WEB APP ENTRY POINTS
   ======================================================================== */
function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { body = {}; }
  return json(handle(body));
}

/* Open the /exec URL in a browser and this is what you get: proof the
   deployment is live, and which schema it is running. If the version here is
   older than the script you pasted, the deployment was never updated —
   Deploy ▸ Manage deployments ▸ edit ▸ New version. */
function doGet() {
  var built = false;
  try { built = ensureSchema(false); } catch (e) {}
  return json({
    ok: true, service: "crm", version: 2,
    schema: SCHEMA_VERSION, builtJustNow: built,
    at: new Date().toISOString()
  });
}

function handle(body) {
  var action = String(body.action || "");
  try {
    // the sheet brings itself up to date before anything reads or writes it
    ensureSchema(false);
    switch (action) {
      case "ping":        return { ok: true, schema: SCHEMA_VERSION, at: new Date().toISOString() };
      case "login":       return apiLogin(body);
      case "logout":      return apiLogout(body);
      case "bootstrap":   return apiBootstrap(body);
      case "save":        return apiSave(body);
      case "remove":      return apiRemove(body);
      case "forward":     return apiForward(body);
      case "advance":     return apiForward(body);   // the old name still works
      case "watch":       return apiWatch(body);
      case "timerStart":  return apiTimerStart(body);
      case "timerStop":   return apiTimerStop(body);
      case "timeSave":    return apiTimeSave(body);
      case "timeRemove":  return apiTimeRemove(body);
      case "changePassword": return apiChangePassword(body);
      case "adminUsers":  return apiAdminUsers(body);
      case "adminSaveUser": return apiAdminSaveUser(body);
      case "adminSaveTag":  return apiAdminSaveTag(body);
      case "adminSaveBadge": return apiAdminSaveBadge(body);
      default:            return { ok: false, error: "Unknown action: " + action };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), code: err && err.code };
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail(msg, code) {
  var e = new Error(msg);
  e.code = code || "error";
  throw e;
}

/* ========================================================================
   SHEET PLUMBING
   ======================================================================== */
function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheetFor(name) {
  var headers = HEAD[name];
  if (!headers) fail("Unknown sheet: " + name);
  var sh = ss().getSheetByName(name);
  if (!sh) {
    sh = ss().insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setBackground("#101620").setFontColor("#dbe7f0");
  }
  return sh;
}

/* Every read and write goes through the sheet's OWN header row rather than
   assuming HEAD's order. That way a sheet built by an older version of this
   script keeps working: any column this version needs and the sheet lacks is
   appended on the right, and nothing already in the sheet moves. */
var _headers = {};
function headersOf(name) {
  if (_headers[name]) return _headers[name];
  var sh = sheetFor(name);
  var want = HEAD[name];
  var lastCol = sh.getLastColumn();
  var row = lastCol
    ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v || "").trim(); })
    : [];
  var missing = want.filter(function (h) { return row.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, row.length + 1, 1, missing.length).setValues([missing]).setFontWeight("bold");
    row = row.concat(missing);
  }
  var map = {};
  row.forEach(function (h, i) { if (h) map[h] = i; });
  return (_headers[name] = { order: row, map: map });
}

function readAll(name) {
  var sh = sheetFor(name);
  var width = headersOf(name).order.length;
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, width).getValues();
}

// rows as objects keyed by header, with the sheet row number kept on _row
function readObjects(name) {
  var h = headersOf(name);
  return readAll(name).map(function (r, i) {
    var o = { _row: i + 2 };
    HEAD[name].forEach(function (key) { o[key] = r[h.map[key]]; });
    return o;
  });
}

function rowFor(name, obj) {
  var h = headersOf(name);
  var row = [];
  for (var i = 0; i < h.order.length; i++) row.push("");
  HEAD[name].forEach(function (key) {
    if (obj[key] !== undefined) row[h.map[key]] = obj[key];
  });
  return row;
}

function writeRow(name, rowNumber, obj) {
  var row = rowFor(name, obj);
  sheetFor(name).getRange(rowNumber, 1, 1, row.length).setValues([row]);
}

function appendObject(name, obj) {
  var sh = sheetFor(name);
  sh.appendRow(rowFor(name, obj));
  return sh.getLastRow();
}

function str(v) { return v === null || v === undefined ? "" : String(v).trim(); }
function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function bool(v) {
  var s = String(v).trim().toLowerCase();
  return v === true || s === "true" || s === "yes" || s === "y" || s === "1";
}
function nowIso() { return new Date().toISOString(); }
function newId(prefix) {
  return prefix + "_" + Utilities.getUuid().replace(/-/g, "").slice(0, 12);
}
function isoDay(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

/* ========================================================================
   TAGS & ACCESS
   ======================================================================== */
// "aujjessa, razzai:r, *"  ->  {all:false, read:{...}, write:{...}}
function parseGrants(cell) {
  var grants = { all: false, read: {}, write: {} };
  str(cell).split(/[,;\n]/).forEach(function (part) {
    var t = str(part).toLowerCase();
    if (!t) return;
    if (t === "*") { grants.all = true; return; }
    var ro = /:r$/.test(t);
    var tag = t.replace(/:r$/, "");
    if (!tag) return;
    grants.read[tag] = true;
    if (!ro) grants.write[tag] = true;
  });
  return grants;
}

function tagList(cell) {
  return str(cell).split(/[,;\n]/)
    .map(function (t) { return str(t).toLowerCase(); })
    .filter(function (t) { return !!t; });
}

function ownsIt(user, record) {
  var owner = str(record.owner || record.userId).toLowerCase();
  return !!owner && owner === user.userId.toLowerCase();
}

function canRead(user, record) {
  if (user.grants.all || user.role === "admin") return true;
  if (ownsIt(user, record)) return true;
  if (str(record.assignee).toLowerCase() === user.userId.toLowerCase()) return true;
  var tags = tagList(record.tags);
  if (!tags.length) return false;            // untagged records stay with their owner
  for (var i = 0; i < tags.length; i++) if (user.grants.read[tags[i]]) return true;
  return false;
}

function canWrite(user, record) {
  if (user.grants.all || user.role === "admin") return true;
  if (ownsIt(user, record)) return true;
  var tags = tagList(record.tags);
  for (var i = 0; i < tags.length; i++) if (user.grants.write[tags[i]]) return true;
  return false;
}

/* ---- tasks follow involvement, not tags ----------------------------------
   A task is only ever seen by the person who raised it, the people watching
   it, whoever holds it now, and whoever has held it along the way. Tags on a
   task say which flow and badges apply; they grant nobody sight of it. */
function onTask(user, task) {
  var me = user.userId.toLowerCase();
  if (str(task.owner).toLowerCase() === me) return true;
  if (str(task.assignee).toLowerCase() === me) return true;
  if (tagList(task.watchers).indexOf(me) >= 0) return true;
  if (tagList(task.participants).indexOf(me) >= 0) return true;
  return false;
}

function canReadTask(user, task) {
  if (user.role === "admin") return true;
  return onTask(user, task);
}

// Editing a task needs involvement too — plus whoever wears a badge the task
// is addressed to right now, so a desk can pick up what has been sent to it.
function canWriteTask(user, task, flow) {
  if (user.role === "admin") return true;
  if (!onTask(user, task)) return false;
  var me = user.userId.toLowerCase();
  if (str(task.owner).toLowerCase() === me) return true;
  if (str(task.assignee).toLowerCase() === me) return true;
  if (flow) {
    var step = stepIn(flow, task.stage);
    if (step && wearsOne(user, step.badges)) return true;
  }
  // a watcher who is not holding it may look but not change it
  return false;
}

function wearsOne(user, badges) {
  if (!badges || !badges.length) return false;
  for (var i = 0; i < badges.length; i++) {
    if (user.badges.indexOf(String(badges[i]).toLowerCase()) >= 0) return true;
  }
  return false;
}

/* ========================================================================
   AUTH
   ======================================================================== */
function findUser(userId) {
  var want = str(userId).toLowerCase();
  if (!want) return null;
  var rows = readObjects("Users");
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i].userId).toLowerCase() !== want) continue;
    var r = rows[i];
    return {
      row: r._row,
      userId: str(r.userId),
      name: str(r.name) || str(r.userId),
      email: str(r.email),
      role: (str(r.role) || "user").toLowerCase(),
      tagsRaw: str(r.tags),
      badges: tagList(r.badges),
      grants: parseGrants(r.tags),
      plain: str(r.password),
      hash: str(r.passwordHash),
      active: str(r.active) === "" ? true : bool(r.active)
    };
  }
  return null;
}

function hashPassword(password, salt) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + "::" + password, Utilities.Charset.UTF_8);
  return raw.map(function (b) {
    return ("0" + (b & 0xff).toString(16)).slice(-2);
  }).join("");
}

// moves a plainly typed password into the hash column and blanks the plain one
function setPasswordForRow(row, password) {
  var salt = Utilities.getUuid().slice(0, 8);
  var sh = sheetFor("Users");
  var map = headersOf("Users").map;
  sh.getRange(row, map.password + 1).setValue("");
  sh.getRange(row, map.passwordHash + 1).setValue(salt + "$" + hashPassword(password, salt));
}

/* The /exec URL is reachable by anyone who knows it, so the one thing worth
   defending is the password. After LOCKOUT_TRIES bad attempts an account stops
   answering for LOCKOUT_MINUTES, which makes guessing useless without
   inconveniencing anyone who simply mistyped. State lives in script
   properties, so it survives between calls and costs nothing to keep. */
var LOCKOUT_TRIES = 8;
var LOCKOUT_MINUTES = 15;

function strikeKey(userId) { return "fail:" + String(userId || "").toLowerCase(); }

function strikesFor(userId) {
  var raw = PropertiesService.getScriptProperties().getProperty(strikeKey(userId));
  if (!raw) return { n: 0, since: 0 };
  var parts = raw.split("|");
  var rec = { n: Number(parts[0]) || 0, since: Number(parts[1]) || 0 };
  if (Date.now() - rec.since > LOCKOUT_MINUTES * 60000) return { n: 0, since: 0 };
  return rec;
}

function noteStrike(userId) {
  var rec = strikesFor(userId);
  PropertiesService.getScriptProperties().setProperty(
    strikeKey(userId), (rec.n + 1) + "|" + (rec.since || Date.now()));
}

function clearStrikes(userId) {
  PropertiesService.getScriptProperties().deleteProperty(strikeKey(userId));
}

function apiLogin(body) {
  var attempted = String(body.userId || "");
  var rec = strikesFor(attempted);
  if (rec.n >= LOCKOUT_TRIES) {
    var left = Math.ceil((LOCKOUT_MINUTES * 60000 - (Date.now() - rec.since)) / 60000);
    fail("Too many failed attempts. Try again in " + Math.max(1, left) + " minute(s).", "auth");
  }

  var u = findUser(attempted);
  if (!u) { noteStrike(attempted); fail("No such user ID.", "auth"); }
  if (!u.active) fail("That account is switched off.", "auth");

  var password = String(body.password || "");
  if (!password) fail("Password required.", "auth");

  // a password still sitting in the plain column is hashed on first use, so an
  // admin can add someone by simply typing one into the sheet
  if (u.plain) {
    setPasswordForRow(u.row, u.plain);
    u = findUser(body.userId);
  }
  if (!u.hash) fail("No password set for this account — ask your admin.", "auth");

  var parts = u.hash.split("$");
  if (parts.length !== 2 || hashPassword(password, parts[0]) !== parts[1]) {
    noteStrike(attempted);
    fail("Wrong password.", "auth");
  }
  clearStrikes(attempted);

  var token = Utilities.getUuid();
  var now = new Date();
  var exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
  appendObject("Sessions", {
    token: token, userId: u.userId,
    createdAt: now.toISOString(), expiresAt: exp.toISOString()
  });

  return { ok: true, token: token, user: profile(u) };
}

function profile(u) {
  var g = u.grants;
  return {
    userId: u.userId, name: u.name, email: u.email, role: u.role,
    tags: u.tagsRaw,
    all: g.all || u.role === "admin",
    read: Object.keys(g.read),
    write: Object.keys(g.write)
  };
}

function apiLogout(body) {
  var sh = sheetFor("Sessions");
  var rows = readObjects("Sessions");
  for (var i = rows.length - 1; i >= 0; i--) {
    if (str(rows[i].token) === str(body.token)) sh.deleteRow(rows[i]._row);
  }
  return { ok: true };
}

function auth(token) {
  var t = str(token);
  if (!t) fail("Signed out.", "auth");
  var rows = readObjects("Sessions");
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i].token) !== t) continue;
    if (new Date(str(rows[i].expiresAt)) < new Date()) fail("Session expired — sign in again.", "auth");
    var u = findUser(rows[i].userId);
    if (!u || !u.active) fail("Account is no longer active.", "auth");
    return u;
  }
  fail("Signed out.", "auth");
}

function requireAdmin(token) {
  var u = auth(token);
  if (u.role !== "admin") fail("Admins only.", "forbidden");
  return u;
}

/* ========================================================================
   READ: everything the app needs after sign-in
   ======================================================================== */
function apiBootstrap(body) {
  var u = auth(body.token);
  var out = {
    ok: true,
    user: profile(u),
    serverDay: isoDay(new Date()),
    tags: readTags(),
    badges: readBadges(),
    lists: readLists(),
    people: readPeople(),
    companies: [],
    contacts: [],
    deals: [],
    tasks: [],
    flows: [],
    flowlog: [],
    time: [],
    running: null
  };

  ENTITIES.forEach(function (name) {
    if (name === "Tasks") return;            // tasks have their own rule, below
    var key = name.toLowerCase();
    out[key] = readObjects(name)
      .filter(function (r) { return str(r.id) && canRead(u, r); })
      .map(function (r) { return cleanRecord(name, r, u); });
  });

  // stages come back parsed — the sheet stores them as one JSON cell
  out.flows.forEach(function (f) {
    f.stages = parseStages(f.stages);
    f.active = f.active === "" ? true : bool(f.active);
  });
  var flowById = {};
  out.flows.forEach(function (f) { flowById[f.id] = { stageList: f.stages }; });

  // only tasks this person is actually involved in
  out.tasks = readObjects("Tasks")
    .filter(function (r) { return str(r.id) && canReadTask(u, r); })
    .map(function (r) {
      var o = cleanRecord("Tasks", r, u);
      o._canWrite = canWriteTask(u, r, flowById[str(r.flowId)]);
      return o;
    });

  // the time log: everyone's rows for tasks this person can see, so the
  // reports add up, but only their own running timer is resumable
  var visibleTasks = {};
  out.tasks.forEach(function (t) { visibleTasks[t.id] = true; });

  readObjects("FlowLog").forEach(function (r) {
    if (!str(r.id) || !visibleTasks[str(r.taskId)]) return;
    out.flowlog.push({
      id: str(r.id), taskId: str(r.taskId), flowId: str(r.flowId), stage: str(r.stage),
      assignee: str(r.assignee), enteredAt: str(r.enteredAt), exitedAt: str(r.exitedAt),
      minutes: num(r.minutes), byUser: str(r.byUser), note: str(r.note)
    });
  });
  var since = isoDay(new Date(Date.now() - TIME_DAYS * 86400000));

  readObjects("TimeLog").forEach(function (r) {
    var id = str(r.id);
    if (!id) return;
    var mine = str(r.userId).toLowerCase() === u.userId.toLowerCase();
    if (!mine && !visibleTasks[str(r.taskId)] && !u.grants.all) return;
    if (str(r.date) && str(r.date) < since) return;
    var row = {
      id: id, taskId: str(r.taskId), userId: str(r.userId), date: str(r.date),
      start: str(r.start), end: str(r.end), minutes: num(r.minutes), note: str(r.note)
    };
    out.time.push(row);
    if (mine && !row.end) out.running = row;
  });

  return out;
}

function cleanRecord(name, r, u) {
  var o = {};
  HEAD[name].forEach(function (h) {
    o[h] = (h === "value" || h === "minutes") ? num(r[h]) : str(r[h]);
  });
  o._canWrite = canWrite(u, r);
  return o;
}

function readTags() {
  var sh = sheetFor("Tags");
  var rows = readObjects("Tags");
  if (!rows.length) {
    sheetFor("Tags").getRange(2, 1, DEFAULT_TAGS.length, HEAD.Tags.length).setValues(DEFAULT_TAGS);
    rows = readObjects("Tags");
  }
  return rows
    .filter(function (r) { return str(r.tag); })
    .map(function (r) {
      return {
        tag: str(r.tag).toLowerCase(),
        label: str(r.label) || str(r.tag),
        colour: str(r.colour) || "#8b98a6",
        order: num(r.order)
      };
    })
    .sort(function (a, b) { return a.order - b.order; });
}

function readBadges() {
  var rows = readObjects("Badges");
  if (!rows.length) {
    sheetFor("Badges").getRange(2, 1, DEFAULT_BADGES.length, HEAD.Badges.length).setValues(DEFAULT_BADGES);
    rows = readObjects("Badges");
  }
  return rows
    .filter(function (r) { return str(r.badge); })
    .map(function (r) {
      return {
        badge: str(r.badge).toLowerCase(),
        label: str(r.label) || str(r.badge),
        colour: str(r.colour) || "#8b98a6",
        order: num(r.order)
      };
    })
    .sort(function (a, b) { return a.order - b.order; });
}

function readLists() {
  var rows = readObjects("Lists");
  if (!rows.length) {
    sheetFor("Lists").getRange(2, 1, DEFAULT_LISTS.length, HEAD.Lists.length)
      .setValues(DEFAULT_LISTS.map(function (l) { return [l[0], l[1], l[1], l[2], l[3]]; }));
    rows = readObjects("Lists");
  }
  var out = {};
  rows.forEach(function (r) {
    var type = str(r.type);
    if (!type || !str(r.value)) return;
    (out[type] = out[type] || []).push({
      value: str(r.value),
      label: str(r.label) || str(r.value),
      colour: str(r.colour) || "#8b98a6",
      order: num(r.order)
    });
  });
  Object.keys(out).forEach(function (k) {
    out[k].sort(function (a, b) { return a.order - b.order; });
  });
  return out;
}

// the roster, so owner/assignee pickers can show names instead of ids
function readPeople() {
  return readObjects("Users")
    .filter(function (r) { return str(r.userId) && (str(r.active) === "" || bool(r.active)); })
    .map(function (r) {
      return {
        userId: str(r.userId), name: str(r.name) || str(r.userId),
        role: (str(r.role) || "user").toLowerCase(),
        badges: tagList(r.badges)
      };
    });
}

/* ========================================================================
   WRITE: one upsert for every CRM entity
   ======================================================================== */
function apiSave(body) {
  var u = auth(body.token);
  var name = String(body.entity || "");
  if (ENTITIES.indexOf(name) < 0) fail("Cannot save " + name + ".");

  var incoming = body.record || {};
  var id = str(incoming.id);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readObjects(name);
    var existing = null;
    for (var i = 0; i < rows.length; i++) {
      if (str(rows[i].id) && str(rows[i].id) === id) { existing = rows[i]; break; }
    }

    var record = {};
    HEAD[name].forEach(function (h) {
      record[h] = existing ? existing[h] : "";
    });

    if (existing) {
      if (name === "Tasks") {
        var fl = str(existing.flowId) ? findFlowQuiet(existing.flowId) : null;
        if (!canWriteTask(u, existing, fl)) fail("You cannot edit that task.", "forbidden");
      } else if (!canWrite(u, existing)) {
        fail("You cannot edit that record.", "forbidden");
      }
    } else {
      record.id = id || newId(name.slice(0, 3).toLowerCase());
      record.owner = u.userId;
      record.createdAt = nowIso();
    }

    // only the editable fields come across the wire; ids and stamps stay ours
    HEAD[name].forEach(function (h) {
      if (h === "id" || h === "createdAt" || h === "updatedAt") return;
      if (incoming[h] === undefined) return;
      if (h === "owner" && !(u.grants.all || u.role === "admin") && existing) return;
      if (h === "stages") {
        // the builder sends an array of stage objects; the sheet holds one JSON cell
        record[h] = typeof incoming[h] === "string"
          ? str(incoming[h])
          : JSON.stringify(incoming[h] || []);
        return;
      }
      record[h] = (h === "value") ? num(incoming[h]) : str(incoming[h]);
    });
    if (!str(record.owner)) record.owner = u.userId;
    record.tags = tagList(record.tags).join(", ");
    record.updatedAt = nowIso();

    if (name === "Tasks") {
      record.watchers = tagList(record.watchers).join(", ");
      // whoever raised it, whoever holds it and whoever touched it are always
      // participants — that is the only thing keeping the task visible to them
      record.participants = addTo(existing ? existing.participants : "",
                                  [record.owner, record.assignee, u.userId]);
    } else if (!canWrite(u, record)) {
      // a record has to stay reachable by whoever wrote it
      fail("Those tags would put the record out of your reach.", "forbidden");
    }

    if (existing) writeRow(name, existing._row, record);
    else appendObject(name, record);

    logActivity(u, name, record.id, existing ? "update" : "create",
                str(record.name || record.title));

    delete record._row;
    record._canWrite = true;
    if (name === "Flows") {
      record.stages = parseStages(record.stages);
      record.active = record.active === "" ? true : bool(record.active);
    }
    return { ok: true, record: record };
  } finally {
    lock.releaseLock();
  }
}

function apiRemove(body) {
  var u = auth(body.token);
  var name = String(body.entity || "");
  if (ENTITIES.indexOf(name) < 0) fail("Cannot delete from " + name + ".");
  var id = str(body.id);
  if (!id) fail("Nothing to delete.");

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readObjects(name);
    for (var i = 0; i < rows.length; i++) {
      if (str(rows[i].id) !== id) continue;
      if (name === "Tasks") {
        // only the person who raised a task, or an admin, may delete it
        if (u.role !== "admin" && str(rows[i].owner).toLowerCase() !== u.userId.toLowerCase()) {
          fail("Only whoever raised this task can delete it.", "forbidden");
        }
      } else if (!canWrite(u, rows[i])) {
        fail("You cannot delete that record.", "forbidden");
      }
      sheetFor(name).deleteRow(rows[i]._row);
      logActivity(u, name, id, "delete", str(rows[i].name || rows[i].title));
      return { ok: true };
    }
    fail("That record is already gone.");
  } finally {
    lock.releaseLock();
  }
}

function logActivity(u, entity, id, action, detail) {
  try {
    appendObject("Activity", {
      at: nowIso(), userId: u.userId, entity: entity,
      entityId: id, action: action, detail: detail || ""
    });
  } catch (e) { /* the audit trail must never block a save */ }
}

/* ========================================================================
   FLOWS — a task's path through its stages
   ======================================================================== */
// the stages cell is one JSON array; a blank or broken cell is simply no stages
function keyList(v) {
  if (v === null || v === undefined) return [];
  var arr = Array.isArray(v) ? v : String(v).split(/[,;]/);
  var out = [];
  arr.forEach(function (x) {
    var s = String(x || "").trim().toLowerCase();
    if (s && out.indexOf(s) < 0) out.push(s);
  });
  return out;
}

function parseStages(cell) {
  var raw = str(cell);
  if (!raw) return [];
  var list;
  try { list = JSON.parse(raw); } catch (e) { return []; }
  if (!list || !list.length) return [];
  var steps = list.map(function (s, i) {
    var name = str(s.name) || ("Step " + (i + 1));
    return {
      key: str(s.key) || name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: name,
      colour: str(s.colour) || "#8b98a6",
      // older flows carried a free-text `role`; it reads as a badge key
      badges: keyList(s.badges !== undefined ? s.badges : s.role),
      next: keyList(s.next),
      slaHours: num(s.slaHours),
      entry: !!s.entry,
      approval: !!s.approval,
      terminal: !!s.terminal
    };
  });
  // a step that names no destinations simply hands on to the following one
  steps.forEach(function (s, i) {
    if (!s.next.length && i < steps.length - 1) s.next = [steps[i + 1].key];
  });
  return steps;
}

function stepIn(flow, key) {
  var steps = flow.stageList || parseStages(flow.stages);
  for (var i = 0; i < steps.length; i++) if (steps[i].key === str(key)) return steps[i];
  return null;
}

// where a task may go from where it is now
function nextKeys(flow, fromKey) {
  var steps = flow.stageList || parseStages(flow.stages);
  if (!str(fromKey)) {
    var entries = steps.filter(function (s) { return s.entry; });
    if (!entries.length && steps.length) entries = [steps[0]];
    return entries.map(function (s) { return s.key; });
  }
  var here = stepIn(flow, fromKey);
  return here ? here.next.slice() : [];
}

// the flow a task points at, without an access check (used for write checks)
function findFlowQuiet(flowId) {
  var rows = readObjects("Flows");
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i].id) === str(flowId)) {
      rows[i].stageList = parseStages(rows[i].stages);
      return rows[i];
    }
  }
  return null;
}

function findFlow(u, flowId) {
  var rows = readObjects("Flows");
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i].id) !== str(flowId)) continue;
    if (!canRead(u, rows[i])) fail("You cannot see that flow.", "forbidden");
    var f = rows[i];
    f.stageList = parseStages(f.stages);
    return f;
  }
  fail("No such flow.");
}

// who, on the roster, wears a given badge
function wearersOf(badge) {
  var want = String(badge || "").toLowerCase();
  if (!want) return [];
  return readObjects("Users").filter(function (r) {
    if (!str(r.userId)) return false;
    if (!(str(r.active) === "" || bool(r.active))) return false;
    return tagList(r.badges).indexOf(want) >= 0;
  }).map(function (r) { return str(r.userId); });
}

/* Forward a task to the next desk.
   Closes the open FlowLog row, opens the next one, reassigns the task to the
   person taking it on, and adds them to the participants — which is what makes
   the task visible to them at all. */
function apiForward(body) {
  var u = auth(body.token);
  var stepKey = str(body.stage);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readObjects("Tasks");
    var existing = null;
    for (var i = 0; i < rows.length; i++) {
      if (str(rows[i].id) === str(body.taskId)) { existing = rows[i]; break; }
    }
    if (!existing) fail("No such task.");

    var flow = findFlow(u, existing.flowId);
    if (!canWriteTask(u, existing, flow)) fail("You cannot move that task.", "forbidden");

    var step = stepIn(flow, stepKey);
    if (!step) fail("That step is not part of this flow.");

    // routing is the point: you may only send it where the map allows
    if (u.role !== "admin") {
      var allowed = nextKeys(flow, existing.stage);
      if (allowed.indexOf(step.key) < 0) {
        var here = stepIn(flow, existing.stage);
        fail("This flow does not go from " + (here ? here.name : "the start") +
             " to " + step.name + ".", "route");
      }
    }

    // who picks it up: the named person, or the only wearer of the badge
    var assignee = str(body.assignee);
    if (step.badges.length) {
      var pool = [];
      step.badges.forEach(function (b) {
        wearersOf(b).forEach(function (w) { if (pool.indexOf(w) < 0) pool.push(w); });
      });
      if (!pool.length) {
        fail("Nobody wears the badge for " + step.name + " yet — add it to someone in Admin.", "route");
      }
      if (!assignee) {
        if (pool.length === 1) assignee = pool[0];
        else fail("Choose who at " + step.name + " should take this on.", "pick");
      }
      var ok = false;
      for (var p = 0; p < pool.length; p++) {
        if (pool[p].toLowerCase() === assignee.toLowerCase()) { ok = true; assignee = pool[p]; break; }
      }
      if (!ok) fail(assignee + " does not wear a badge for " + step.name + ".", "route");
    } else if (!assignee && step.terminal) {
      assignee = str(existing.assignee);          // a final step stays with whoever finished it
    }

    var now = new Date();
    var logs = readObjects("FlowLog");
    var closed = null;
    for (var k = logs.length - 1; k >= 0; k--) {
      if (str(logs[k].taskId) !== str(existing.id) || str(logs[k].exitedAt)) continue;
      var entered = new Date(str(logs[k].enteredAt));
      closed = {
        id: str(logs[k].id), taskId: str(logs[k].taskId), flowId: str(logs[k].flowId),
        stage: str(logs[k].stage), assignee: str(logs[k].assignee),
        enteredAt: str(logs[k].enteredAt), exitedAt: now.toISOString(),
        minutes: Math.max(0, Math.round((now.getTime() - entered.getTime()) / 60000)),
        byUser: str(logs[k].byUser), note: str(logs[k].note)
      };
      writeRow("FlowLog", logs[k]._row, closed);
      break;
    }

    var opened = {
      id: newId("fl"), taskId: str(existing.id), flowId: str(flow.id), stage: step.key,
      assignee: assignee, enteredAt: now.toISOString(), exitedAt: "", minutes: 0,
      byUser: u.userId, note: str(body.note)
    };
    appendObject("FlowLog", opened);

    var record = {};
    HEAD.Tasks.forEach(function (h) { record[h] = existing[h]; });
    record.stage = step.key;
    if (assignee) record.assignee = assignee;
    record.participants = addTo(record.participants, [assignee, u.userId]);
    if (step.terminal) record.status = "Done";
    else if (str(record.status) === "Done") record.status = "In Progress";
    record.updatedAt = now.toISOString();
    writeRow("Tasks", existing._row, record);

    logActivity(u, "Tasks", record.id, "forward", step.name + " → " + (assignee || "unassigned"));
    delete record._row;
    record._canWrite = canWriteTask(u, record, flow);
    return { ok: true, task: record, closed: closed, opened: opened };
  } finally {
    lock.releaseLock();
  }
}

/* Add or remove a watcher. Anyone who can see the task may add someone — that
   is how you pull a colleague in — and may always take themselves off. */
function apiWatch(body) {
  var u = auth(body.token);
  var who = str(body.who).toLowerCase();
  if (!who) fail("Nobody named.");

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readObjects("Tasks");
    var existing = null;
    for (var i = 0; i < rows.length; i++) {
      if (str(rows[i].id) === str(body.taskId)) { existing = rows[i]; break; }
    }
    if (!existing) fail("No such task.");
    if (!canReadTask(u, existing)) fail("You cannot see that task.", "forbidden");

    var list = tagList(existing.watchers);
    var at = list.indexOf(who);
    if (body.remove) {
      if (at < 0) return { ok: true, task: taskOut(u, existing) };
      // taking someone else off needs more than being a watcher yourself
      if (who !== u.userId.toLowerCase() && u.role !== "admin" &&
          str(existing.owner).toLowerCase() !== u.userId.toLowerCase() &&
          str(existing.assignee).toLowerCase() !== u.userId.toLowerCase()) {
        fail("Only the person who raised it, whoever holds it, or they themselves can remove a watcher.", "forbidden");
      }
      list.splice(at, 1);
    } else {
      if (at >= 0) return { ok: true, task: taskOut(u, existing) };
      if (!findUser(who)) fail("No such user.");
      list.push(who);
    }

    var record = {};
    HEAD.Tasks.forEach(function (h) { record[h] = existing[h]; });
    record.watchers = list.join(", ");
    record.updatedAt = nowIso();
    writeRow("Tasks", existing._row, record);
    logActivity(u, "Tasks", record.id, body.remove ? "unwatch" : "watch", who);
    delete record._row;
    return { ok: true, task: taskOut(u, record) };
  } finally {
    lock.releaseLock();
  }
}

function taskOut(u, task) {
  var out = {};
  HEAD.Tasks.forEach(function (h) { out[h] = str(task[h]); });
  var flow = null;
  if (str(task.flowId)) {
    var flows = readObjects("Flows");
    for (var i = 0; i < flows.length; i++) {
      if (str(flows[i].id) === str(task.flowId)) {
        flow = flows[i]; flow.stageList = parseStages(flow.stages); break;
      }
    }
  }
  out._canWrite = canWriteTask(u, task, flow);
  return out;
}

// merge user ids into a comma list without duplicating or losing order
function addTo(cell, add) {
  var list = tagList(cell);
  (add || []).forEach(function (x) {
    var s = String(x || "").trim().toLowerCase();
    if (s && list.indexOf(s) < 0) list.push(s);
  });
  return list.join(", ");
}

/* ========================================================================
   THE TIMER
   ======================================================================== */
function findTask(u, taskId) {
  var rows = readObjects("Tasks");
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i].id) === str(taskId)) {
      if (!canReadTask(u, rows[i])) fail("You cannot see that task.", "forbidden");
      return rows[i];
    }
  }
  fail("No such task.");
}

function myRunning(userId) {
  var rows = readObjects("TimeLog");
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i].userId).toLowerCase() === String(userId).toLowerCase() && !str(rows[i].end)) {
      return rows[i];
    }
  }
  return null;
}

// Starting a timer closes whatever else was running: one clock per person.
function apiTimerStart(body) {
  var u = auth(body.token);
  findTask(u, body.taskId);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var stopped = null;
    var open = myRunning(u.userId);
    if (open) {
      if (str(open.taskId) === str(body.taskId)) {
        return { ok: true, running: timeRow(open), stopped: null };
      }
      stopped = closeRow(open, new Date());
    }

    var now = new Date();
    var row = {
      id: newId("tl"), taskId: str(body.taskId), userId: u.userId,
      date: isoDay(now), start: now.toISOString(), end: "", minutes: 0,
      note: str(body.note), createdAt: now.toISOString()
    };
    appendObject("TimeLog", row);
    return { ok: true, running: timeRow(row), stopped: stopped };
  } finally {
    lock.releaseLock();
  }
}

function apiTimerStop(body) {
  var u = auth(body.token);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var open = myRunning(u.userId);
    if (!open) return { ok: true, stopped: null, running: null };
    if (body.id && str(open.id) !== str(body.id)) fail("That timer is not the one running.");
    var stopped = closeRow(open, new Date(), str(body.note));
    return { ok: true, stopped: stopped, running: null };
  } finally {
    lock.releaseLock();
  }
}

function closeRow(open, endDate, note) {
  var start = new Date(str(open.start));
  var minutes = Math.max(0, Math.round((endDate.getTime() - start.getTime()) / 60000));
  var record = {
    id: str(open.id), taskId: str(open.taskId), userId: str(open.userId),
    date: str(open.date) || isoDay(start),
    start: start.toISOString(), end: endDate.toISOString(),
    minutes: minutes, note: note || str(open.note), createdAt: str(open.createdAt)
  };
  writeRow("TimeLog", open._row, record);
  return timeRow(record);
}

function timeRow(r) {
  return {
    id: str(r.id), taskId: str(r.taskId), userId: str(r.userId), date: str(r.date),
    start: str(r.start), end: str(r.end), minutes: num(r.minutes), note: str(r.note)
  };
}

// a hand-typed or corrected session
function apiTimeSave(body) {
  var u = auth(body.token);
  var incoming = body.record || {};
  var taskId = str(incoming.taskId);
  findTask(u, taskId);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readObjects("TimeLog");
    var existing = null;
    for (var i = 0; i < rows.length; i++) {
      if (str(rows[i].id) && str(rows[i].id) === str(incoming.id)) { existing = rows[i]; break; }
    }
    if (existing && str(existing.userId).toLowerCase() !== u.userId.toLowerCase()
        && u.role !== "admin") {
      fail("That session belongs to someone else.", "forbidden");
    }

    var start = incoming.start ? new Date(str(incoming.start)) : new Date();
    var end = incoming.end ? new Date(str(incoming.end)) : null;
    var minutes = incoming.minutes !== undefined && incoming.minutes !== ""
      ? Math.max(0, Math.round(num(incoming.minutes)))
      : (end ? Math.max(0, Math.round((end - start) / 60000)) : 0);

    var record = {
      id: existing ? str(existing.id) : newId("tl"),
      taskId: taskId,
      userId: existing ? str(existing.userId) : u.userId,
      date: str(incoming.date) || isoDay(start),
      start: start.toISOString(),
      end: end ? end.toISOString() : "",
      minutes: minutes,
      note: str(incoming.note),
      createdAt: existing ? str(existing.createdAt) : nowIso()
    };

    if (existing) writeRow("TimeLog", existing._row, record);
    else appendObject("TimeLog", record);
    return { ok: true, record: timeRow(record) };
  } finally {
    lock.releaseLock();
  }
}

function apiTimeRemove(body) {
  var u = auth(body.token);
  var id = str(body.id);
  var rows = readObjects("TimeLog");
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i].id) !== id) continue;
    if (str(rows[i].userId).toLowerCase() !== u.userId.toLowerCase() && u.role !== "admin") {
      fail("That session belongs to someone else.", "forbidden");
    }
    sheetFor("TimeLog").deleteRow(rows[i]._row);
    return { ok: true };
  }
  return { ok: true };
}

/* ========================================================================
   SELF SERVICE
   ======================================================================== */
function apiChangePassword(body) {
  var u = auth(body.token);
  var next = String(body.next || "");
  if (next.length < 4) fail("Pick a password of at least 4 characters.");

  // the current password still has to check out, even with a live session
  var current = String(body.current || "");
  if (u.plain) {
    if (current !== u.plain) fail("Current password is wrong.", "auth");
  } else {
    var parts = u.hash.split("$");
    if (parts.length !== 2 || hashPassword(current, parts[0]) !== parts[1]) {
      fail("Current password is wrong.", "auth");
    }
  }
  setPasswordForRow(u.row, next);
  return { ok: true };
}

/* ========================================================================
   ADMIN — users and the tag catalogue
   ======================================================================== */
function apiAdminUsers(body) {
  requireAdmin(body.token);
  return {
    ok: true,
    users: readObjects("Users").filter(function (r) { return str(r.userId); }).map(function (r) {
      return {
        userId: str(r.userId), name: str(r.name), email: str(r.email),
        role: (str(r.role) || "user").toLowerCase(), tags: str(r.tags),
        badges: str(r.badges),
        active: str(r.active) === "" ? true : bool(r.active),
        hasPassword: !!(str(r.password) || str(r.passwordHash))
      };
    })
  };
}

function apiAdminSaveUser(body) {
  var admin = requireAdmin(body.token);
  var incoming = body.record || {};
  var userId = str(incoming.userId);
  if (!userId) fail("A user ID is required.");

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readObjects("Users");
    var existing = null;
    for (var i = 0; i < rows.length; i++) {
      if (str(rows[i].userId).toLowerCase() === userId.toLowerCase()) { existing = rows[i]; break; }
    }

    // an admin must not lock themselves out of their own admin rights
    if (existing && str(existing.userId).toLowerCase() === admin.userId.toLowerCase()
        && str(incoming.role).toLowerCase() !== "admin") {
      fail("You cannot remove your own admin role.", "forbidden");
    }

    var record = {
      userId: existing ? str(existing.userId) : userId,
      name: incoming.name !== undefined ? str(incoming.name) : str(existing && existing.name),
      email: incoming.email !== undefined ? str(incoming.email) : str(existing && existing.email),
      role: (incoming.role !== undefined ? str(incoming.role) : str(existing && existing.role) || "user").toLowerCase(),
      tags: tagList(incoming.tags !== undefined ? incoming.tags : (existing && existing.tags)).join(", "),
      badges: tagList(incoming.badges !== undefined ? incoming.badges : (existing && existing.badges)).join(", "),
      password: "",
      passwordHash: existing ? str(existing.passwordHash) : "",
      active: incoming.active !== undefined ? !!incoming.active
            : (existing ? (str(existing.active) === "" ? true : bool(existing.active)) : true)
    };
    if (record.role !== "admin") record.role = "user";

    var row;
    if (existing) { writeRow("Users", existing._row, record); row = existing._row; }
    else { row = appendObject("Users", record); }

    if (str(incoming.password)) setPasswordForRow(row, str(incoming.password));

    logActivity(admin, "Users", record.userId, existing ? "update" : "create", record.name);
    return { ok: true, record: { userId: record.userId, name: record.name, email: record.email,
      role: record.role, tags: record.tags, badges: record.badges, active: record.active,
      hasPassword: !!(record.passwordHash || str(incoming.password)) } };
  } finally {
    lock.releaseLock();
  }
}

function apiAdminSaveTag(body) {
  var admin = requireAdmin(body.token);
  var incoming = body.record || {};
  var tag = str(incoming.tag).toLowerCase();
  if (!tag) fail("A tag name is required.");
  if (tag === "*") fail("'*' is reserved — it means every tag.");

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readObjects("Tags");
    var existing = null;
    for (var i = 0; i < rows.length; i++) {
      if (str(rows[i].tag).toLowerCase() === tag) { existing = rows[i]; break; }
    }
    if (incoming.remove && existing) {
      sheetFor("Tags").deleteRow(existing._row);
      return { ok: true, removed: tag };
    }
    var record = {
      tag: tag,
      label: str(incoming.label) || (existing ? str(existing.label) : tag),
      colour: str(incoming.colour) || (existing ? str(existing.colour) : "#8b98a6"),
      order: incoming.order !== undefined ? num(incoming.order)
           : (existing ? num(existing.order) : rows.length)
    };
    if (existing) writeRow("Tags", existing._row, record);
    else appendObject("Tags", record);
    logActivity(admin, "Tags", tag, existing ? "update" : "create", record.label);
    return { ok: true, record: record };
  } finally {
    lock.releaseLock();
  }
}

function apiAdminSaveBadge(body) {
  var admin = requireAdmin(body.token);
  var incoming = body.record || {};
  var badge = str(incoming.badge).toLowerCase().replace(/[^a-z0-9\-]+/g, "-").replace(/^-|-$/g, "");
  if (!badge) fail("A badge name is required.");

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rows = readObjects("Badges");
    var existing = null;
    for (var i = 0; i < rows.length; i++) {
      if (str(rows[i].badge).toLowerCase() === badge) { existing = rows[i]; break; }
    }
    if (incoming.remove && existing) {
      sheetFor("Badges").deleteRow(existing._row);
      return { ok: true, removed: badge };
    }
    var record = {
      badge: badge,
      label: str(incoming.label) || (existing ? str(existing.label) : badge),
      colour: str(incoming.colour) || (existing ? str(existing.colour) : "#8b98a6"),
      order: incoming.order !== undefined ? num(incoming.order)
           : (existing ? num(existing.order) : rows.length)
    };
    if (existing) writeRow("Badges", existing._row, record);
    else appendObject("Badges", record);
    logActivity(admin, "Badges", badge, existing ? "update" : "create", record.label);
    return { ok: true, record: record };
  } finally {
    lock.releaseLock();
  }
}

/* ========================================================================
   SETUP — there is nothing to run.

   ensureSchema() builds everything the first time the app calls in, and
   again whenever SCHEMA_VERSION changes because you pasted a newer script.
   It creates missing tabs, appends missing columns without moving anything
   already in the sheet, and seeds the catalogues. When the sheet is already
   current it costs one property read, so it is safe on every request.
   ======================================================================== */
function ensureSchema(force) {
  var props = PropertiesService.getScriptProperties();
  if (!force && props.getProperty("schema") === SCHEMA_VERSION) return false;

  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { return false; }           // someone else is already building it

  try {
    if (!force && props.getProperty("schema") === SCHEMA_VERSION) return false;

    Object.keys(HEAD).forEach(function (name) { sheetFor(name); headersOf(name); });
    readTags();
    readBadges();
    readLists();

    if (!readObjects("Flows").length) {
      appendObject("Flows", {
        id: newId("flw"), name: DEFAULT_FLOW.name, tags: DEFAULT_FLOW.tags,
        description: DEFAULT_FLOW.description, stages: JSON.stringify(DEFAULT_FLOW.stages),
        active: true, owner: "admin", createdAt: nowIso(), updatedAt: nowIso()
      });
    }
    // the first admin, only while Users is still empty
    if (!readObjects("Users").length) {
      appendObject("Users", {
        userId: "admin", name: "Admin", email: "", role: "admin",
        tags: "*", badges: "cro-manager", password: "changeme", passwordHash: "", active: true
      });
    }

    props.setProperty("schema", SCHEMA_VERSION);
    return true;
  } finally {
    lock.releaseLock();
  }
}

/* ---- the sheet's own menu: a repair kit, not a required step ---- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("CRM")
    .addItem("Health check", "healthCheck")
    .addItem("Rebuild sheets now", "setupSheets")
    .addItem("Clear login sessions", "clearSessions")
    .addToUi();
}

function setupSheets() {
  ensureSchema(true);
  SpreadsheetApp.getUi().alert(
    "CRM backend rebuilt.\n\n" +
    "Schema " + SCHEMA_VERSION + ". Every tab and column is present.\n\n" +
    "You do not normally need this — the app builds and updates the sheet " +
    "by itself. Use it only if something looks wrong."
  );
}

function healthCheck() {
  ensureSchema(false);
  var lines = ["CRM backend", "Schema: " + SCHEMA_VERSION, ""];

  var users = readObjects("Users").filter(function (r) { return str(r.userId); });
  var admins = users.filter(function (r) { return (str(r.role) || "user").toLowerCase() === "admin"; });
  var plain = users.filter(function (r) { return str(r.password); });
  var badges = readBadges();
  var flows = readObjects("Flows").filter(function (r) { return str(r.id); });

  lines.push("People: " + users.length + "  (" + admins.length + " admin)");
  lines.push("Badges: " + badges.length);
  lines.push("Tags:   " + readTags().length);
  lines.push("Flows:  " + flows.length);
  lines.push("Tasks:  " + readObjects("Tasks").filter(function (r) { return str(r.id); }).length);
  lines.push("");

  var warn = [];
  if (!admins.length) warn.push("- No admin account. Nobody can manage people.");
  if (plain.length) {
    warn.push("- " + plain.length + " account(s) still have a plain password in " +
              "the sheet. It is hashed the first time each signs in.");
  }
  users.forEach(function (r) {
    if (!str(r.badges)) warn.push("- " + str(r.userId) + " wears no badge, so no flow step can be handed to them.");
  });
  flows.forEach(function (f) {
    var steps = parseStages(f.stages);
    if (!steps.length) { warn.push("- Flow \"" + str(f.name) + "\" has no steps."); return; }
    if (!steps.some(function (s) { return s.entry; })) {
      warn.push("- Flow \"" + str(f.name) + "\" has no entry step; the first one is used.");
    }
    steps.forEach(function (s) {
      s.badges.forEach(function (b) {
        if (!wearersOf(b).length) {
          warn.push("- \"" + str(f.name) + " › " + s.name + "\" is addressed to the badge " +
                    "\"" + b + "\", which nobody wears.");
        }
      });
    });
  });

  lines.push(warn.length ? "Worth a look:\n" + warn.join("\n") : "Nothing to fix.");
  SpreadsheetApp.getUi().alert(lines.join("\n"));
}

function clearSessions() {
  var sh = sheetFor("Sessions");
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  SpreadsheetApp.getUi().alert("Everyone has been signed out.");
}
