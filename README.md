# Ciceley — personal writing site

A static site built with [Hugo](https://gohugo.io) using the
[Stack](https://github.com/CaiJimmy/hugo-theme-stack) theme (recoloured
girly-pink). Writing is authored in **Notion**, synced to Markdown by a small
script, opened as a **pull request**, and published when the PR merges to
`main`.

```
Notion database ──(scripts/notion-sync.mjs)──▶ content/posts/*.md ──(hugo)──▶ public/
                                                        │
                                              pull request ──merge──▶ deploy
```

## What's in here

| Path | Purpose |
| --- | --- |
| `hugo.toml` | Site config (title, menu, pink palette hooks) |
| `content/posts/` | Blog posts (page bundles: `index.md` + images) |
| `content/about/`, `content/search/`, `content/archives/` | Standalone pages |
| `assets/scss/custom.scss` | Pink theme overrides |
| `layouts/_partials/head/custom-font.html` | Playfair Display + Poppins fonts |
| `themes/hugo-theme-stack` | Stack theme (git submodule, pinned to v4.0.3) |
| `scripts/notion-sync.mjs` | Notion → Markdown (content only) |
| `scripts/sync-pr.sh` | Runs the sync, commits, pushes a branch, opens a PR |
| `.github/workflows/notion-sync.yml` | Scheduled/manual sync that opens a PR |
| `flake.nix` | Dev shell (`hugo`, `node`) and `nix build .#site` |

## Prerequisites

Everything is provided by the Nix flake:

```bash
nix develop          # hugo (extended), node, gh, git, jq
npm install          # one-time: fetch sync dependencies
```

(If you don't use Nix: install Hugo **extended** ≥ 0.157 and Node ≥ 20.)
After cloning, init the theme submodule:

```bash
git submodule update --init --recursive
```

## Local preview

```bash
nix develop
npm run dev          # http://localhost:1313
# or a one-off production build:
npm run build        # → ./public
```

## One-time Notion setup

The Notion API is **free** — you only need a Notion account.

1. Create an internal integration at <https://www.notion.so/my-integrations>
   and copy the **token**.
2. Create a database in Notion to hold your posts. Expected properties
   (all optional except the title — sensible defaults are used otherwise):

   | Property | Type | Notes |
   | --- | --- | --- |
   | `Name` | Title | Post title (any title property works) |
   | `Slug` | Text | URL slug; defaults to a slugified title |
   | `Date` | Date | Defaults to today |
   | `Description` | Text | Used for SEO / previews |
   | `Tags` | Multi-select | |
   | `Categories` | Multi-select | |
   | `Status` | Select/Status | Only `Published` is synced |
   | `Published` | Checkbox | Alternative to `Status` |

3. On the database page: **••• → Connections → add your integration**.
4. Copy the database id from the URL
   (`https://www.notion.so/<workspace>/<DATABASE_ID>?v=...`).
5. Create your `.env`:

   ```bash
   cp .env.example .env
   # then set NOTION_API_KEY and NOTION_DATABASE_ID
   ```

   In the browser you write normally — use headings, bold, images, quotes,
   lists, and Notion's own cover image. Inline images and covers are
   downloaded into each post's folder automatically.

## Publishing a post

**Locally:**

```bash
npm run sync:pr      # syncs Notion, commits, pushes a branch, opens a PR
```

Review the PR, then merge to `main`.

**Automatically (GitHub Actions):** the `notion-sync` workflow runs every 6
hours and on demand (**Actions → Notion → Hugo (open PR) → Run workflow**).
It needs two repository secrets:

- `NOTION_API_KEY`
- `NOTION_DATABASE_ID`

Nothing is published until a PR is merged.

Only posts that were created by the sync are ever updated or deleted — pages
you drop in `content/` by hand are left untouched.

## Deployment (self-hosted k3s + Flux)

Merging a PR to `main` runs `.github/workflows/deploy.yml`, which builds the
site, packages it into an nginx image, pushes it to GHCR, and bumps the image
tag in `deploy/flux/deployment.yaml`. Flux then reconciles the new tag.

```
merge to main ──▶ Actions: hugo build ──▶ docker build ──▶ GHCR ──▶ Flux ──▶ k3s
```

### One-time setup

1. **Pick the image path.** The workflow uses `ghcr.io/${{ github.repository }}`
   lowercased — for this repo that's `ghcr.io/ciceley/ciceleywebsite`. The Flux
   manifests in `deploy/flux/` assume the same value; update them if you point
   at a different registry/repo.
2. **Let the cluster pull the image.** Create/refresh the `ghcr-secret` pull
   secret in the `apps` namespace with a PAT that can read the package:
   ```bash
   kubectl -n apps create secret docker-registry ghcr-secret \
     --docker-server=ghcr.io \
     --docker-username=<gh-user> \
     --docker-password=<PAT-with-read:packages> \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
3. **Set the real domain** in `deploy/flux/ingress.yaml` (currently
   `ciceley.example.com`) and, optionally, set the repo variable
   `SITE_BASEURL` (Settings → Variables) to override `hugo.toml`'s `baseURL` at
   build time.
4. **Wire it into Flux.** In your Flux repo (`bakuran-sosyal`), add a
   `GitRepository` pointing at this repo and a `Kustomization` that applies
   `./deploy/flux`:
   ```yaml
   apiVersion: source.toolkit.fluxcd.io/v1
   kind: GitRepository
   metadata:
     name: ciceleywebsite
     namespace: flux-system
   spec:
     interval: 1m
     url: https://github.com/Ciceley/ciceleywebsite
     ref: { branch: main }
   ---
   apiVersion: kustomize.toolkit.fluxcd.io/v1
   kind: Kustomization
   metadata:
     name: ciceleywebsite
     namespace: flux-system
   spec:
     interval: 10m
     sourceRef: { kind: GitRepository, name: ciceleywebsite }
     path: ./deploy/flux
     prune: true
   ```
   (This repo is public; for a private repo add a `secretRef` with a deploy
   key.)

### Building the image locally

```bash
nix develop -c hugo --minify     # produces ./public
docker build -t ciceley-site .   # nginx + ./public
docker run --rm -p 8080:80 ciceley-site
```

You can also skip Docker entirely and serve the generated files:

```bash
nix build .#site                 # → ./result
```

## Notes

- Stack requires the **extended** Hugo build (SCSS + esbuild). The Nix flake and
  the Actions workflow both use it.
- `hugo.toml` keeps a placeholder `baseURL`; set the repo variable
  `SITE_BASEURL` or edit it before a manual `hugo` build.
- The deploy workflow ignores changes under `deploy/flux/**` so its own
  manifest-bump commits don't re-trigger a build.
