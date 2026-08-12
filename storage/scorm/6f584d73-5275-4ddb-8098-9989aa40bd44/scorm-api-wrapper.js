/* ============================================================================
   scorm-api-wrapper.js
   Dual-standard SCORM run-time wrapper — works against BOTH SCORM 1.2 and
   SCORM 2004 (2nd/3rd/4th Edition) without any change to the content.

   It discovers whichever API the LMS exposes (window.API for 1.2, or
   window.API_1484_11 for 2004), then normalises the data-model differences
   behind one small facade: window.SCORM.

   If no LMS API is found (e.g. opened straight from disk for preview), every
   method becomes a safe no-op so the course still runs standalone.

   No dependencies. Classic script. Define before the content script.
   ============================================================================ */
(function (w) {
  "use strict";

  var api = null;        // the raw LMS API object
  var version = null;    // "1.2" | "2004"
  var started = false;   // Initialize succeeded
  var finished = false;  // Terminate/Finish called
  var startMs = 0;       // session clock

  /* ---- API discovery (standard SCORM find-the-API walk) ----------------- */
  function findIn(win) {
    if (!win) return null;
    var tries = 0;
    while (win && tries < 12) {
      if (win.API_1484_11) { version = "2004"; return win.API_1484_11; }
      if (win.API)         { version = "1.2";  return win.API; }
      if (win.parent && win.parent !== win) { win = win.parent; tries++; }
      else break;
    }
    return null;
  }
  function discover() {
    var found = findIn(w);
    if (!found && w.opener) found = findIn(w.opener);
    return found;
  }

  /* ---- low-level calls, dispatched by version --------------------------- */
  function lmsGet(el) {
    if (!api) return "";
    return version === "2004" ? api.GetValue(el) : api.LMSGetValue(el);
  }
  function lmsSet(el, val) {
    if (!api) return "false";
    return version === "2004" ? api.SetValue(el, String(val))
                              : api.LMSSetValue(el, String(val));
  }
  function lmsCommit() {
    if (!api) return "false";
    return version === "2004" ? api.Commit("") : api.LMSCommit("");
  }

  /* ---- time formatting -------------------------------------------------- */
  // 1.2 wants CMITimespan  HHHH:MM:SS.SS
  function fmt12(ms) {
    var s = Math.floor(ms / 1000);
    var hh = Math.floor(s / 3600);
    var mm = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(hh) + ":" + p(mm) + ":" + p(ss) + ".00";
  }
  // 2004 wants ISO-8601 duration  PT#H#M#S
  function fmt2004(ms) {
    var s = Math.floor(ms / 1000);
    var hh = Math.floor(s / 3600);
    var mm = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    var out = "PT";
    if (hh) out += hh + "H";
    if (mm) out += mm + "M";
    out += ss + "S";
    return out;
  }

  /* ---- the public facade ------------------------------------------------ */
  var SCORM = {
    get version() { return version; },
    get available() { return !!api; },

    init: function () {
      api = discover();
      if (!api) return false;            // standalone preview — no-op mode
      var ok = (version === "2004") ? api.Initialize("") : api.LMSInitialize("");
      if (String(ok) !== "true") { api = null; return false; }
      started = true;
      startMs = Date.now();

      // Mark the attempt as in progress if the LMS has it as not-attempted.
      if (version === "2004") {
        if (lmsGet("cmi.completion_status") === "not attempted")
          lmsSet("cmi.completion_status", "incomplete");
      } else {
        var st = lmsGet("cmi.core.lesson_status");
        if (!st || st === "not attempted" || st === "")
          lmsSet("cmi.core.lesson_status", "incomplete");
      }
      lmsCommit();

      // Always close the session cleanly when the learner leaves.
      var quit = SCORM.quit;
      w.addEventListener("pagehide", quit, false);
      w.addEventListener("beforeunload", quit, false);
      w.addEventListener("unload", quit, false);
      return true;
    },

    // "ab-initio" (fresh) | "resume" | "" (unknown)
    entry: function () {
      if (!api) return "";
      return version === "2004" ? lmsGet("cmi.entry") : lmsGet("cmi.core.entry");
    },

    getSuspendData: function () { return api ? lmsGet("cmi.suspend_data") : ""; },
    setSuspendData: function (str) { if (api) lmsSet("cmi.suspend_data", str); },

    getLocation: function () {
      if (!api) return "";
      return version === "2004" ? lmsGet("cmi.location") : lmsGet("cmi.core.lesson_location");
    },
    setLocation: function (loc) {
      if (!api) return;
      version === "2004" ? lmsSet("cmi.location", loc)
                         : lmsSet("cmi.core.lesson_location", loc);
    },

    // 2004 only — 0..1 progress bar in the LMS. Ignored on 1.2.
    setProgress: function (frac) {
      if (!api || version !== "2004") return;
      var f = Math.max(0, Math.min(1, frac));
      lmsSet("cmi.progress_measure", f.toFixed(3));
    },

    setScore: function (raw, min, max) {
      if (!api) return;
      raw = Math.round(raw);
      if (version === "2004") {
        lmsSet("cmi.score.raw", raw);
        lmsSet("cmi.score.min", min == null ? 0 : min);
        lmsSet("cmi.score.max", max == null ? 100 : max);
        var lo = (min == null ? 0 : min), hi = (max == null ? 100 : max);
        var scaled = hi > lo ? (raw - lo) / (hi - lo) : raw / 100;
        lmsSet("cmi.score.scaled", Math.max(0, Math.min(1, scaled)).toFixed(4));
      } else {
        lmsSet("cmi.core.score.raw", raw);
        lmsSet("cmi.core.score.min", min == null ? 0 : min);
        lmsSet("cmi.core.score.max", max == null ? 100 : max);
      }
    },

    // Final outcome of a scored course.
    setPassed: function (passed) {
      if (!api) return;
      if (version === "2004") {
        lmsSet("cmi.completion_status", "completed");
        lmsSet("cmi.success_status", passed ? "passed" : "failed");
      } else {
        lmsSet("cmi.core.lesson_status", passed ? "passed" : "failed");
      }
    },

    // Completion without a pass/fail judgement (unscored material).
    setComplete: function () {
      if (!api) return;
      version === "2004" ? lmsSet("cmi.completion_status", "completed")
                         : lmsSet("cmi.core.lesson_status", "completed");
    },

    commit: function () { if (api) lmsCommit(); },

    quit: function () {
      if (!api || finished) return;
      finished = true;
      var elapsed = Date.now() - startMs;
      if (version === "2004") {
        lmsSet("cmi.session_time", fmt2004(elapsed));
        lmsCommit();
        api.Terminate("");
      } else {
        lmsSet("cmi.core.session_time", fmt12(elapsed));
        lmsCommit();
        api.LMSFinish("");
      }
    }
  };

  w.SCORM = SCORM;
})(window);
