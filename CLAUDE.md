# Project Notes

## Building

Always rebuild after any code change:

```bash
npm run build
```

## Testing

```bash
npm run test:nlp   # offline NLP pipeline (kuromoji + JMdict), runs in Node
npm run test:e2e   # Playwright: loads the built extension in Chromium
```

## Git workflow

Standard GitHub flow:

```bash
git checkout -b <short-feature-branch>   # branch off main
# ...make changes...
npm run build                            # always rebuild before committing
git add -p
git commit -m "type(scope): summary"     # e.g. fix(word-render): ...
git push -u origin <short-feature-branch>
# open a PR against main (or push straight to main for small solo changes)
```

`dist/` is a build artifact and is git-ignored; never commit it. The committed
`package-lock.json` keeps installs reproducible (`npm ci`).

NO COAUTHORING IN THE COMMIT MESSAGES.
