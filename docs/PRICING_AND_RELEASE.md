# Public offer and implementation status

## Offer displayed in the website

| Package | Monthly | Annual, paid once | Language | Experience |
| --- | ---: | ---: | --- | --- |
| Essential | EGP 300 | EGP 3,000 | One language; English content available now | Guided path, placement estimate, scenarios, story, writing, pronunciation transcript comparison, review and progress |
| Plus | EGP 450 | EGP 4,500 | One language; English content available now | Essential plus live text AI coach and dynamic conversation only when a server provider is configured |
| Groups | Custom quote | Custom quote | Scope agreed in meeting | Request form captures team size and preferred Cairo time; the meeting is confirmed manually |

An annual subscription saves the price of two months compared with twelve monthly payments. German, Spanish and French are interest registrations only until complete language packs are prepared. Do not sell access to their content before activation.

## Pricing reasoning

EGP 300/month makes a self-study product with guided scenarios and review accessible below the published price of teacher-led courses in Egypt. For context, the British Council's Egyptian classroom packages are EGP 6,000 for 20 lessons over three months, EGP 10,000 for 40 over six months, and EGP 13,000 for 60 over nine months (accessed 23 October 2026): https://www.britishcouncil.org.eg/en/english/adults/classes . This is a different service category and not a direct feature-for-feature price comparison. Busuu differentiates Premium and Premium Plus with AI conversations and targeted practice: https://www.busuu.com/en/premium-plans . Duolingo's practice path mixes new lessons, Stories, speaking, tailored practice and review: https://blog.duolingo.com/ways-to-practice-in-duolingo/ . USAM Language uses those patterns as product research; neither their content nor visual identity is copied.

Review actual conversion, retention, model usage cost, and support workload before treating these offer prices as fixed business economics. The Plus package needs measured per-user AI limits and entitlements before paid activation.

## What works today

The marketing website has routes for home, languages, method, pricing, groups, contact, FAQ and about, plus an interactive sample lesson. It has monthly/yearly plan switching and preselects the plan in the contact form. The EC2 Node API accepts and validates lead requests at `POST /api/leads`, limits to five per IP per hour, and appends them to `LEADS_FILE` (default `data/leads.jsonl`). Treat the file as personal data: private permissions, backup, retention, and access for authorized staff only. There is no calendar reservation; the preferred date/time is a request requiring manual confirmation. The hosted static preview stores a demo request only in the visitor's browser and explicitly says so.

## Remaining launch integrations

The website does not collect money or activate subscriptions. Connect the chosen Egyptian payment gateway and verify payment webhooks server-side before granting a language entitlement. Add authenticated USAM SSO, a durable per-user learner record, a billing and cancellation portal, a real scheduling calendar with availability, staff lead notifications/CRM connection, and privacy/terms copy approved for your business. The sample lesson and learner onboarding remain explorable during review; they are not a paid entitlement gate. The live AI coach requires a server key and usage controls. Do not market the preview as a fully operational paid service.
