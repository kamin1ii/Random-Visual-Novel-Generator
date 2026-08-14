# Random Visual Novel Generator

A random visual novel generator and browser built on the [VNDB](https://vndb.org) API. Set filters, generate a randomized list of matching titles, and browse the results one at a time with cover art, stats, tags, and a synopsis.

**Live demo:** https://kamin1ii.github.io/Random-Visual-Novel-Generator/

Vanilla HTML, CSS, and ES modules.

![Screenshot](https://i.postimg.cc/vmRSM20L/screenshot.png)

## Features

- Filter by minimum score, minimum vote count, and release year range
- Filter by original language (Japanese) and English release status, including partial patches and machine translations
- Filter by playtime length
- Include and exclude specific VNDB tags, each with independent AND/OR match modes, using a debounced autocomplete search against the VNDB tag database
- Generates a randomized list (50 to 300 titles) from all matching results, with a new random subset and browsing order on every generate
- Browse one title at a time by clicking the card, using the Prev/Next buttons, or the left/right arrow keys
- Cover art preloads for nearby entries in the list so navigation feels instant
- Sensitive cover art is blurred by default with a click-to-reveal option
- Content tags are capped to a short preview per title with an option to expand the rest in place, plus a link to the full tag list on VNDB for anything filtered out of that preview
- Responsive layout for narrower screens
