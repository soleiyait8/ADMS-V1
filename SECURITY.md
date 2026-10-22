# Security Policy

ADMS processes employee personal data and biometric-derived attendance records
(sensitive personal information under the Philippine Data Privacy Act of 2012).

## Reporting a vulnerability
Use **Security → Report a vulnerability** on this repository (private advisory).
Do not open public issues for security problems.

## Rules for contributors
- Never commit `.env` files, tokens, passwords, TLS keys, or database dumps. `.gitignore` excludes the usual ones; check `git status` before committing.
- If a secret is ever committed or shared, revoke it immediately — deleting the commit is not enough.
- Never commit real employee records, device serial numbers of production units (if the repository is public), or any biometric template/photo data.
- Enable GitHub **secret scanning** and **push protection** (Settings → Code security).
