# My News

A private, ad-free homepage built from six news sites' RSS feeds.

- `sources.json`: the six sources (name, feed URL, accent color, story count).
- `build.mjs`: pulls each feed, takes the newest stories, and writes `public/index.html` plus one clean reader page per story in `public/a/`. When a feed carries only a summary, it fetches the article and extracts the main text and images with Mozilla Readability. Everything is sanitized: no scripts, iframes, forms or ads.
- `.github/workflows/build.yml`: runs twice a day and on demand. It builds the site, encrypts every page with StatiCrypt using the `PAGE_PASSWORD` secret, deploys to GitHub Pages, and commits `last-run.txt` so GitHub doesn't pause the schedule.
- Article cache lives in `.cache/data.json`, deliberately outside `public/`, so it is never published. `public/` itself is build output and is never committed.

To add, remove or reorder a site, edit `sources.json`.
