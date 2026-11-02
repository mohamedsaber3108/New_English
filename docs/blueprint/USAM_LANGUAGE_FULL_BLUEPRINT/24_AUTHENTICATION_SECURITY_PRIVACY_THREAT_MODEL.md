# Authentication Security Privacy Threat Model

Threats and controls: password theft→scrypt; session theft→hashed HttpOnly tokens/revoke; reset enumeration→generic response and expiring one-use token; CSRF→SameSite plus origin check; payment forgery→server amount/HMAC/idempotency; data loss→atomic write/backup; abuse→rate limits; AI leakage→truncation/narrow prompts. Distributed controls and legal retention remain gates.

## Acceptance and status
**Implemented** means present in source and covered by build or smoke evidence. **Configured** means code exists but needs a deployment secret/provider account. **Planned** means no production claim. English is the only active paid language pack; placement is guidance rather than an accredited CEFR certificate.

## Ownership and review
Product owns scope and copy; engineering owns implementation and observability; content owns language quality and rights; operations owns support and reconciliation; legal/finance own policy, tax and retention sign-off. Review this file when its mapped feature or gate changes.
