---
"@ieedan/label": patch
---

Prevent reapplying labels whose latest human label action was removal. Read paginated GitHub label history, refresh it before additions, and allow a later human addition to lift the veto.
