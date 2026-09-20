# Poplur Beta Tester NDA — Jotform Sign

- Builder (Mark's account): https://www.jotform.com/sign/262578645789076
- **Public signing link (Signer 1 = tester):** https://www.jotform.com/sign/262578246361059/invite/01m2m27ga7749cfceb153b8ca4
- Signed copies land in Jotform → My Sign Documents → Poplur-Beta-Tester-NDA (Inbox).
- Fields on page 3 (Signer 1): Name (first/last), Discord username, Email, Signature, Date. Mark's side has no fields (one-way NDA; countersignature not needed).
- Free tier: 10 signed documents / month. Bronze (~US$34/mo) → 100.
- A stray plain form "Sign Form" (https://www.jotform.com/build/262578700671058) was created by the wrong entry point — safe to delete.

## 20 Sep 2026 — signing moved onto poplur.ca (no per-signature fee)

The invite email from poplur.ca now carries a signed, 14-day link to `https://www.poplur.ca/nda?t=…`
(PoplurApp/src/app/nda.tsx). The tester reads the agreement there, types their name, ticks "read and
agree" and "18+", and the TestFlight / Google Play links unlock on the page and arrive by email. Each
signature emails a signed copy to the tester and a copy to Poplur (`BETA_NDA_RECORDS_TO`, falling back to
`BETA_EMAIL_REPLY_TO`) carrying name, email, time, agreement version and the SHA-256 of the text signed.
The agreement text lives in `src/nda/betaTesterNda.ts` (version 2026-09-20; section 10 now describes the
site instead of Jotform). Jotform is no longer needed for website sign-ups; the PDF/DOCX here still show the
Jotform wording in section 10 until `build-nda.js` is re-run with the new text.
