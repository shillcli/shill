# Reporting a security problem

Found something that leaks a token or posts where it should not? Please tell us
privately: open a draft advisory at https://github.com/OWNER/shill/security/advisories/new.
Do not open a public issue for it.

Send the shill version, the command or tool call, and what someone could do with it.
We aim to answer within 7 days and to ship a fix before anything is made public.

## What shill touches

- **LLM providers.** Only commit subjects, scopes, PR numbers, author handles and the
  version leave your machine. Never code or diffs.
- **Webhooks and bot tokens.** Used for the one request you asked for and stripped
  from error messages. Keep them in secrets, not in workflow files.
- **The dashboard.** Binds to 127.0.0.1, refuses non-local Host headers and has no
  endpoint that posts anything.
