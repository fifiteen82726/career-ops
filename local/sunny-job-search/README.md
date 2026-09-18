# Sunny Global Job Search

Start the local-only site:

```sh
node local/sunny-job-search/serve.mjs
```

Open http://127.0.0.1:4173.

Refresh the local snapshot after the daily publisher updates `data/sunny-job-search-archive.json`:

```sh
node data/tools/build-sunny-job-search-index.mjs
node local/sunny-job-search/referrals.mjs status
```

The refresh validates input and replaces the browser snapshot atomically. Private-data overrides resolve from the career-ops data root, not the shell working directory. LinkedIn is optional: a logged-out or challenged session retains eligible cached referral matches and never prevents the site from loading.

The `最近 Connections` section is derived locally from each job's `referralContacts`. It shares the page's query, priority, and date filters, groups visible jobs by current connection and employer, and lets the user select one or more same-company jobs to generate an editable referral message. Filtering a selected job out of view also removes it from the message selection.
