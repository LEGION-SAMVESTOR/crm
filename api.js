"use strict";
/* ============================================================================
   API — the only place that talks to the Apps Script backend.

   The CRM is shared data, so unlike Ledger it is deliberately online-first:
   every write goes straight to the sheet and the reply is what the UI trusts.
   Nothing is queued, so two people can never silently overwrite each other
   with a stale local snapshot.
   ========================================================================== */
const API = (function () {
  /* The deployed /exec URL, so nobody is ever asked to paste one. It is
     base64 here only to keep it from being a plain, greppable string in the
     page source — that is obscurity, not security, and anyone determined can
     still read it out of this file.

     What actually protects the sheet: the URL on its own grants nothing. Every
     call has to carry a session token from a real ID and password, the backend
     throttles failed logins, and this repository is private.

     To point at a different backend, replace the string below with
     btoa("https://…/exec"), or set it to "" and each device is asked once and
     keeps the answer in its own localStorage. */
  const BAKED = "aHR0cHM6Ly9zY3JpcHQuZ29vZ2xlLmNvbS9tYWNyb3Mvcy9BS2Z5Y2J6TVc5ZlNQZ0R1YzJxOURKR1pFam1GZ1JESGF0LXMxTVFLWC13TGFicHZXMG03eUpQRENpMnZkSHIwVjB6Uk5QVG5jdy9leGVj";
  const BAKED_URL = BAKED ? atob(BAKED) : "";

  const K_URL = "crm.api.url";
  const K_TOKEN = "crm.api.token";
  const K_USER = "crm.api.user";

  const state = { busy: 0, lastError: "", lastSync: null };
  const listeners = [];

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { }
  }

  const url = () => BAKED_URL || localStorage.getItem(K_URL) || "";
  const setUrl = u => localStorage.setItem(K_URL, String(u || "").trim());
  const token = () => localStorage.getItem(K_TOKEN) || "";
  const setToken = t => t ? localStorage.setItem(K_TOKEN, t) : localStorage.removeItem(K_TOKEN);
  const user = () => read(K_USER, null);
  const setUser = u => u ? write(K_USER, u) : localStorage.removeItem(K_USER);

  function tagged(msg, code) {
    const e = new Error(msg);
    e.code = code;
    return e;
  }

  /* The one network primitive. No custom headers, so the browser keeps this a
     "simple" request and never sends a preflight OPTIONS — which an Apps
     Script web app cannot answer. */
  async function call(action, payload) {
    const endpoint = url();
    if (!endpoint) throw tagged("No backend URL set.", "config");

    const body = Object.assign({ action }, payload || {});
    if (body.token === undefined && token()) body.token = token();

    state.busy++; state.lastError = ""; emit();
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        redirect: "follow",
        body: JSON.stringify(body)
      });
    } catch (err) {
      state.busy--; state.lastError = "Cannot reach the sheet."; emit();
      throw tagged("Cannot reach the sheet.", "network");
    }

    const text = await res.text();
    state.busy--;
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      state.lastError = "Bad reply from the backend."; emit();
      throw tagged('The backend URL did not return data. Check the deployment is a ' +
        'Web app with access set to "Anyone".', "config");
    }
    if (!data.ok) {
      state.lastError = data.error || "The sheet refused that."; emit();
      const err = tagged(state.lastError, data.code || "server");
      if (err.code === "auth") signedOut();
      throw err;
    }
    state.lastSync = Date.now(); emit();
    return data;
  }

  function signedOut() {
    setToken(""); setUser(null);
    listeners.forEach(fn => { try { fn(state, "auth"); } catch (e) { } });
  }

  function emit() { listeners.forEach(fn => { try { fn(state); } catch (e) { } }); }
  function onChange(fn) { listeners.push(fn); fn(state); }

  async function login(userId, password) {
    const r = await call("login", { userId, password, token: "" });
    setToken(r.token);
    setUser(r.user);
    return r.user;
  }

  async function logout() {
    try { await call("logout"); } catch (e) { /* going offline is no reason to stay signed in */ }
    setToken(""); setUser(null);
  }

  const host = () => {
    const u = url();
    if (!u) return "no backend";
    try { return new URL(u).host; } catch (e) { return u.slice(0, 40); }
  };

  return {
    call, login, logout, onChange, state, signedOut,
    url, setUrl, token, setToken, user, setUser, host,
    baked: () => !!BAKED_URL,
    bootstrap: () => call("bootstrap"),
    save: (entity, record) => call("save", { entity, record }),
    remove: (entity, id) => call("remove", { entity, id }),
    forward: (taskId, stage, assignee, note) => call("forward", { taskId, stage, assignee, note }),
    watch: (taskId, who, remove) => call("watch", { taskId, who, remove: !!remove }),
    messages: taskId => call("messages", { taskId }),
    postMessage: (taskId, text) => call("postMessage", { taskId, text }),
    timerStart: (taskId, note) => call("timerStart", { taskId, note }),
    timerStop: (id, note) => call("timerStop", { id, note }),
    timeSave: record => call("timeSave", { record }),
    timeRemove: id => call("timeRemove", { id }),
    adminUsers: () => call("adminUsers"),
    saveUser: record => call("adminSaveUser", { record }),
    saveTag: record => call("adminSaveTag", { record }),
    saveOrg:   (kind, record) => call("adminSaveOrg", { kind, record }),
    changePassword: (current, next) => call("changePassword", { current, next })
  };
})();
