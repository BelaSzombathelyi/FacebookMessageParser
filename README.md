# FacebookMessageParser

Tampermonkey userscript for exporting the currently opened Facebook Messenger conversation to a Markdown file that can be shared with an LLM.

## Files

- `FacebookMessageParser.user.js` – the Tampermonkey script

## Usage

1. Install the script in Tampermonkey.
2. Open a conversation on `facebook.com/messages` (or `messenger.com` while it is still available).
3. Click the **Export chat to Markdown** button in the bottom-right corner.
4. The script scrolls upward to load older visible messages, extracts sender/date/message data, and downloads a `.md` file.

## Export format

The downloaded Markdown file contains:

- conversation title
- export timestamp
- source URL
- a per-message list with sender, timestamp/date, and message text

## Notes

- Facebook updates its UI often, so the script uses resilient DOM heuristics instead of brittle class names.
- The export works best when the target conversation is already open and the page has finished loading.
