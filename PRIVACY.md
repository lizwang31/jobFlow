# Privacy Policy — JobFlow

*Last updated: March 2025*

## What data we collect

**We collect nothing.**

JobFlow is a fully client-side Chrome extension. It has no servers, no analytics, no telemetry, and no accounts.

## What data stays on your device

The following is stored locally in Chrome's storage on your own machine:

- Your job application records (company, title, status, dates)
- Your API keys (Notion, OpenAI, Pinecone, Anthropic)
- Your resume text chunks (after you upload your resume)
- AI analysis results

None of this is transmitted to any server operated by this extension.

## Third-party services

When you use the extension, it makes direct API calls to services **you configure**:

| Service | Data sent | Their privacy policy |
|---------|-----------|---------------------|
| Notion API | Job application data you choose to save | [notion.so/privacy](https://notion.so/privacy) |
| OpenAI API | Resume text chunks, job description text | [openai.com/privacy](https://openai.com/privacy) |
| Anthropic API | Same as above (if you choose Claude) | [anthropic.com/privacy](https://anthropic.com/privacy) |
| Pinecone | Embedding vectors (numerical representations of text) | [pinecone.io/privacy](https://pinecone.io/privacy) |

Your API keys are stored in `chrome.storage.sync` and only ever sent to the respective API endpoints.

## Permissions

- `storage` — to save your settings and job records locally
- `activeTab` / `scripting` — to detect Apply button clicks on job pages
- Host permissions for LinkedIn, Indeed — to run the content script on those pages
- Host permissions for api.notion.com, api.openai.com, etc. — to make direct API calls

## Contact

Open an issue at [github.com/YOUR_USERNAME/notionify-jobs/issues](https://github.com/YOUR_USERNAME/notionify-jobs/issues)
