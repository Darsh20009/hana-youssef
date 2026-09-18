---
name: MongoDB Atlas secret formatting
description: Environment-specific constraint for MongoDB Atlas SRV connection strings stored as Replit secrets.
---

MongoDB Atlas SRV connection strings must be stored as one continuous value with no whitespace or line breaks inside the hostname.

**Why:** A pasted space in the SRV hostname causes Node's DNS lookup to fail with `querySrv EBADNAME`, preventing the application from starting.

**How to apply:** If startup reports `querySrv EBADNAME`, ask for the secret to be re-entered from Atlas exactly as copied, without modifying or displaying the secret value.