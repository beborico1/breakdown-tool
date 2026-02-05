# Project Notes

## Building

Always rebuild after any code change:

```bash
npm run build
```

## Pushing Changes

This project lives inside a sparse checkout of the internship repo. To push changes:

```bash
# 1. Sync files to the internship repo
rsync -av --delete --exclude='.git' --exclude='node_modules' --exclude='.DS_Store' \
  /Users/luisrico/dev/google-meet-caption-copier/ \
  /Users/luisrico/dev/internship_quest_submission/2024/Luis_Rico/Extra/google-meet-caption-analyzer/

# 2. Commit and push from the internship repo
cd /Users/luisrico/dev/internship_quest_submission
git add 2024/Luis_Rico/Extra/google-meet-caption-analyzer/
git commit -m "your commit message"
git push origin main
```

## Remote Repository

- **Repo**: `git@gitlab03.irvine.jp:irvine/internship/internship_quest_submission.git`
- **Path**: `2024/Luis_Rico/Extra/google-meet-caption-analyzer`

Do NOT add a remote origin to this local repo - it syncs via rsync to the internship monorepo.

NO COAUTHORING IN THE COMMIT MESSAGES.