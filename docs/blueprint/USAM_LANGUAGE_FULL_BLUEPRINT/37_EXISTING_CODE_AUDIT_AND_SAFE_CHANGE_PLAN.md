# Existing Code Audit And Safe Change Plan

Preserved: landing composition, wordmark, palette, dark mode, header, pricing, language cards, learning shell and existing activities. Added around them: recovery/verification, sessions/preferences, support/receipts/admin/audit, trust/resources/placement/payment pages, consent/PWA, EC2/env/backup and API smoke. Technical debt: large React files, JSON persistence, bearer-only admin and raw admin JSON viewer. Release flow: diff→check/build/smoke→visual preview→provider staging→gates→immutable package→health/core journey.

## Acceptance and status
**Implemented** means present in source and covered by build or smoke evidence. **Configured** means code exists but needs a deployment secret/provider account. **Planned** means no production claim. English is the only active paid language pack; placement is guidance rather than an accredited CEFR certificate.

## Ownership and review
Product owns scope and copy; engineering owns implementation and observability; content owns language quality and rights; operations owns support and reconciliation; legal/finance own policy, tax and retention sign-off. Review this file when its mapped feature or gate changes.
