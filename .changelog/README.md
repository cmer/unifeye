# Unreleased changes

Each file here is one change for the next release's notes. `scripts/release.sh` writes them into
`CHANGELOG.md` under the new version and deletes them. One file per change keeps branches from
clashing in `CHANGELOG.md`.

Name: `<yyyymmddhhmmss in UTC>-<short_change_name>.md`, for example
`20261119143000-clips_up_to_two_hours.md`. Content, always in this form:

```markdown
---
section: Fixed
---

One change, in plain language. It may wrap onto more lines.
```

`section` is `Added`, `Changed`, `Fixed` or `Removed`. Write the text without a leading `- `.

`node scripts/changelog.mjs add fixed clips_up_to_two_hours "Clips can be up to two hours long."`
creates one with the right name, and `node scripts/changelog.mjs check` checks them all.
