# Engine Entitlement Payment

The engine accepts authoritative order/webhook state and outputs language, plan and expiry. Redirect never activates; success may extend current expiry; refund removes the matching entitlement; duplicates are idempotent.

## Acceptance and status
**Implemented** means present in source and covered by build or smoke evidence. **Configured** means code exists but needs a deployment secret/provider account. **Planned** means no production claim. English is the only active paid language pack; placement is guidance rather than an accredited CEFR certificate.

## Ownership and review
Product owns scope and copy; engineering owns implementation and observability; content owns language quality and rights; operations owns support and reconciliation; legal/finance own policy, tax and retention sign-off. Review this file when its mapped feature or gate changes.
