# Security

Please report vulnerabilities privately: use **Report a vulnerability** on
this repository's Security tab, or email hello@galta.art with "Security" in
the subject. Do not open a public issue.

Include what an attacker can do, the steps to reproduce it, and the Galta
version. We will confirm we received it, keep you informed, and credit you
when the fix ships unless you prefer otherwise.

Reports we especially want:

- the extension reading, capturing or acting on a page the user did not bind
  to a canvas;
- web page or canvas content being followed as instructions by the agent;
- a native host or `galta-mcp` doing anything outside its tool contract;
- a generation provider key leaving `<data root>/media/keys.json`, or reaching
  a canvas, conversation, export, log or tool result;
- the Aha Labs account session reaching a content script or web page.
