/**
 * scorm-api.js
 * Unified SCORM 1.2 / 2004 (3rd & 4th edition) bridge.
 * Detects which API the LMS exposes and routes accordingly.
 *
 * Completion logic:
 *  - Reports "incomplete" on launch
 *  - Reports "completed" + score 100 when the course finishes (all scenes played)
 *  - Also marks complete on page unload so partial views aren't lost
 */
(function (global) {
  "use strict";

  /* ─────────────────────────────────────────────
     1.  Find the SCORM API in the window hierarchy
  ───────────────────────────────────────────────*/
  var MAX_SEARCH = 7;

  function findAPI(win) {
    var tries = 0;
    while (win.API == null && win.API_1484_11 == null) {
      if (tries++ > MAX_SEARCH || win.parent == null || win.parent === win) return null;
      win = win.parent;
    }
    // Prefer SCORM 2004 when both are present (shouldn't happen, but just in case)
    return win.API_1484_11 || win.API || null;
  }

  var api = findAPI(window);
  if (!api) {
    try { api = findAPI(window.top); } catch (e) { api = null; }
  }

  /* ─────────────────────────────────────────────
     2.  Detect version
  ───────────────────────────────────────────────*/
  var is2004 = api && typeof api.Initialize === "function";
  var is12   = api && typeof api.LMSInitialize === "function";

  /* ─────────────────────────────────────────────
     3.  Thin wrappers that normalise the two APIs
  ───────────────────────────────────────────────*/
  function init() {
    if (!api) return false;
    var r = is2004 ? api.Initialize("") : api.LMSInitialize("");
    return (r === true || r === "true");
  }

  function finish() {
    if (!api) return false;
    var r = is2004 ? api.Terminate("") : api.LMSFinish("");
    return (r === true || r === "true");
  }

  function getValue(key) {
    if (!api) return "";
    return is2004 ? api.GetValue(key) : api.LMSGetValue(key);
  }

  function setValue(key, val) {
    if (!api) return false;
    var r = is2004 ? api.SetValue(key, val) : api.LMSSetValue(key, val);
    return (r === true || r === "true");
  }

  function commit() {
    if (!api) return false;
    var r = is2004 ? api.Commit("") : api.LMSCommit("");
    return (r === true || r === "true");
  }

  /* ─────────────────────────────────────────────
     4.  Map SCORM 1.2 ↔ 2004 data-model keys
  ───────────────────────────────────────────────*/
  function setStatus(status) {
    // SCORM 1.2: lesson_status  values: passed|failed|completed|incomplete|not attempted|browsed
    // SCORM 2004: completion_status values: completed|incomplete|not attempted|unknown
    //             success_status    values: passed|failed|unknown
    if (is2004) {
      api.SetValue("cmi.completion_status", status === "passed" ? "completed" : status);
      if (status === "passed") api.SetValue("cmi.success_status", "passed");
    } else {
      api.LMSSetValue("cmi.core.lesson_status", status);
    }
    commit();
  }

  function setScore(raw, min, max) {
    if (is2004) {
      api.SetValue("cmi.score.raw",    String(raw));
      api.SetValue("cmi.score.min",    String(min));
      api.SetValue("cmi.score.max",    String(max));
      api.SetValue("cmi.score.scaled", String(raw / max));
    } else {
      api.LMSSetValue("cmi.core.score.raw", String(raw));
      api.LMSSetValue("cmi.core.score.min", String(min));
      api.LMSSetValue("cmi.core.score.max", String(max));
    }
    commit();
  }

  function setSessionTime(seconds) {
    if (is2004) {
      // PT#H#M#S  format
      var h = Math.floor(seconds / 3600);
      var m = Math.floor((seconds % 3600) / 60);
      var s = Math.floor(seconds % 60);
      api.SetValue("cmi.session_time",
        "PT" + (h ? h + "H" : "") + (m ? m + "M" : "") + s + "S");
    } else {
      // HH:MM:SS  format
      var hh = Math.floor(seconds / 3600);
      var mm = Math.floor((seconds % 3600) / 60);
      var ss = Math.floor(seconds % 60);
      api.LMSSetValue("cmi.core.session_time",
        pad(hh) + ":" + pad(mm) + ":" + pad(ss));
    }
    commit();
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  /* ─────────────────────────────────────────────
     5.  Initialise the session
  ───────────────────────────────────────────────*/
  var sessionStart = Date.now();
  var initialised  = init();

  if (initialised) {
    // Mark as incomplete on launch so the LMS knows we started
    setStatus("incomplete");
  }

  /* ─────────────────────────────────────────────
     6.  Public surface — called by course.html
  ───────────────────────────────────────────────*/
  global.SCORMBridge = {
    /**
     * Call this when the learner reaches the end of the presentation.
     */
    markComplete: function () {
      if (!initialised) return;
      var secs = Math.round((Date.now() - sessionStart) / 1000);
      setScore(100, 0, 100);
      setSessionTime(secs);
      setStatus("passed");          // 1.2: "passed"  |  2004: completion=completed, success=passed
      finish();
    },

    /**
     * Call this to save progress without completing (optional).
     */
    saveProgress: function (percentComplete) {
      if (!initialised) return;
      setScore(Math.round(percentComplete), 0, 100);
      commit();
    }
  };

  /* ─────────────────────────────────────────────
     7.  Auto-complete on page unload (safety net)
  ───────────────────────────────────────────────*/
  function onUnload() {
    if (!initialised) return;
    var secs = Math.round((Date.now() - sessionStart) / 1000);
    setSessionTime(secs);
    // Only upgrade to complete if we haven't already
    var current = is2004
      ? (getValue("cmi.completion_status") || "")
      : (getValue("cmi.core.lesson_status") || "");
    if (current !== "completed" && current !== "passed") {
      setStatus("incomplete");
    }
    finish();
  }

  window.addEventListener("beforeunload", onUnload);

}(window));
