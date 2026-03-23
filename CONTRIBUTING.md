# Contributing to JobFlow

Thanks for your interest! Here's how to get started.

## Development setup

```bash
git clone https://github.com/YOUR_USERNAME/notionify-jobs.git
cd notionify-jobs

# Load in Chrome
# chrome://extensions → Developer mode → Load unpacked → select this folder
```

No build step required — the extension runs directly from source.

## Adding a new job platform

1. Add the site's URL pattern to `manifest.json` under `host_permissions` and `content_scripts.matches`
2. Add an extractor function in `src/content/index.js`:

```js
function extractGreenhouseJob() {
  return {
    title:    document.querySelector(".job-title")?.innerText?.trim() ?? "",
    company:  document.querySelector(".company-name")?.innerText?.trim() ?? "",
    location: document.querySelector(".location")?.innerText?.trim() ?? "",
    salary:   "",
    url:      location.href,
    platform: "Greenhouse",
  };
}
```

3. Update the `SITE` detection and `extractJobInfo()` dispatcher
4. Test on a real job page and open a PR

## Good first issues

- [ ] Glassdoor support
- [ ] Greenhouse / Lever / Workday support
- [ ] Improve salary extraction (LinkedIn often hides it)
- [ ] Add "copy JD" button to popup for manual analysis
- [ ] Export all applications to CSV

## Code style

- Vanilla JS (no bundler, no framework) — keeps the extension simple and auditable
- Prefer `async/await` over promise chains
- Keep functions small and single-purpose
- Add a one-line comment above any non-obvious logic
