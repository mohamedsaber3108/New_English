# System Architecture And Decision Records

Topology: browser → Nginx/TLS → Node/Express → React static files, customer JSON, leads JSONL, Paymob, Resend and OpenAI. Decisions: one EC2 process for controlled launch; hash routes for existing static compatibility; hosted Paymob to avoid card storage; guided fallback for AI; migrate to PostgreSQL and shared realtime before horizontal scale.

## Acceptance and status
**Implemented** means present in source and covered by build or smoke evidence. **Configured** means code exists but needs a deployment secret/provider account. **Planned** means no production claim. English is the only active paid language pack; placement is guidance rather than an accredited CEFR certificate.

## Ownership and review
Product owns scope and copy; engineering owns implementation and observability; content owns language quality and rights; operations owns support and reconciliation; legal/finance own policy, tax and retention sign-off. Review this file when its mapped feature or gate changes.
