# USAM Language

React and Node application for the USAM Language paid English learning experience. The approved dark green and mint identity is preserved across Arabic acquisition pages and the English learner workspace.

## Verify

```bash
npm ci
npm run check
npm run build
npm run test:api
```

Use `npm run dev` for static preview and `npm start` for the EC2 service. Copy `.env.example` outside the repository and supply secrets there. Deployment is documented in `docs/EC2.md`.

## Status

Source build and API smoke tests pass. Paymob, Resend, OpenAI, domain/TLS, monitoring, legal/tax review, accessibility/device QA and backup restore require environment-specific prelaunch evidence. See the full blueprint under `docs/blueprint/USAM_LANGUAGE_FULL_BLUEPRINT`.
