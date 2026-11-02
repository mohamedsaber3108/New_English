# Database Schema Erd And Data Lifecycle

Entities: User, Session, SecurityToken, Order, SupportTicket, AuditEvent, Lead and AnalyticsEvent. Starter persistence is an atomic single-writer JSON file plus JSONL leads. Deletion removes user/session/token/support data and anonymizes audit identity. Financial retention must be reconciled legally before production. Multi-instance deployment requires PostgreSQL.

## Acceptance and status
**Implemented** means present in source and covered by build or smoke evidence. **Configured** means code exists but needs a deployment secret/provider account. **Planned** means no production claim. English is the only active paid language pack; placement is guidance rather than an accredited CEFR certificate.

## Ownership and review
Product owns scope and copy; engineering owns implementation and observability; content owns language quality and rights; operations owns support and reconciliation; legal/finance own policy, tax and retention sign-off. Review this file when its mapped feature or gate changes.
