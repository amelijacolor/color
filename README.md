# Ameli Mor — Portfolio & Private Admin Panel

## 1. Publishing to GitHub Pages + Your Custom URL

1. Create a GitHub repository and push this entire project folder (`git init`, `git add .`, `git commit -m "Initial site"`, `git remote add origin ...`, `git push -u origin main`).
   - `.gitignore` automatically excludes `private/` so local passwords, backups, and messages are never pushed to GitHub.
2. In your GitHub repo, open **Settings → Pages → Build and deployment** and set **Source** to **`GitHub Actions`**.
   - `.github/workflows/deploy.yml` automatically deploys **only the `site/` folder**.
3. Under **Custom domain**, enter your custom URL (e.g., `amelimor.com`), configure your DNS records with your domain provider, and enable **Enforce HTTPS**.

## 2. Accessing Your Admin Panel on Your Custom URL

Once your site is live at your custom URL, open:

```text
https://your-custom-domain.com/admin/
```

- **Why it’s safe:** There are **no passwords, tokens, or secrets** stored in GitHub or in the site code. Anyone visiting `/admin/` only sees an empty sign-in screen.
- **How you sign in:** Enter your GitHub username, repository name, branch (`main`), and a **GitHub Fine-Grained Personal Access Token** scoped **only** to this repository with `Contents: Read and write` permission (step-by-step instructions are built right into the login screen).
- When you edit films, festival wins/counts, Before & After grades, or About/Contact and click **Save & Publish**, your browser commits directly to GitHub via HTTPS and GitHub Pages updates your live site automatically in ~30–60 seconds.

## 3. Editing Locally on Your Mac (Optional — Best for Large Videos)

Double-click **`start.command`** in Finder to run both local servers:
- **Local Admin Panel:** `http://127.0.0.1:8091` (supports videos up to 600 MB, local password auth, local backups, and a **Publish to GitHub** tab)
- **Local Website Preview:** `http://127.0.0.1:8090`
