OPERATING AI — A Field Course for Product Managers
SCORM packages (Edstellar)
==================================================

This folder contains the SAME course packaged two ways. Upload whichever
your LMS asks for. The HTML content and the run-time JavaScript are
byte-identical across both packages — only imsmanifest.xml differs.

  Operating-AI_SCORM_1.2.zip      → import where the LMS wants SCORM 1.2
  Operating-AI_SCORM_2004.zip     → import where the LMS wants SCORM 2004 (4th Ed)

WHY TWO ZIPS, NOT ONE
---------------------
SCORM 1.2 and SCORM 2004 use different, mutually exclusive manifest schemas,
so a single imsmanifest.xml cannot validate as both. The run-time wrapper,
however, auto-detects which API the LMS exposes (window.API for 1.2 or
window.API_1484_11 for 2004) and adapts every call automatically — so the
content itself never has to be rebuilt for one standard or the other.

WHAT THE COURSE REPORTS TO THE LMS
----------------------------------
  • Initialises the attempt on launch (status -> incomplete).
  • Bookmark + resume: screen position, knowledge-check answers and
    assessment answers are saved to suspend_data and restored on return.
  • Progress bar (SCORM 2004 progress_measure) as the learner advances.
  • Final score (0–100) from the 8-question assessment, with min/max
    (and scaled 0–1 on 2004).
  • Pass/fail at the 70% mark:
      1.2   -> cmi.core.lesson_status = passed | failed
      2004  -> cmi.completion_status = completed, cmi.success_status = passed | failed
  • Session time and a clean Commit + Terminate/Finish on exit.

NOTES
-----
  • Fonts load from Google Fonts (online). With no connection the course
    falls back to system fonts; nothing breaks.
  • The XSD schema files are referenced but not bundled. Mainstream LMSs
    (SCORM Cloud, Moodle, TalentLMS, Cornerstone, Docebo, etc.) import
    without them. If your conformance process requires the physical XSDs,
    drop the ADL/IMS schema files beside imsmanifest.xml before zipping.
  • Tested target: SCORM 2004 4th Edition. The wrapper is also compatible
    with 2nd/3rd Edition LMS runtimes.
