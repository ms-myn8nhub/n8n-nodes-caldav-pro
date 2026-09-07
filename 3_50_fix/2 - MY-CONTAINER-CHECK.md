# Your container copy — check results

Repo checked: `ms-myn8nhub/n8n-caldav-pro` (commit `af084a1`), i.e. the installed package folder
`~/.n8n/nodes/node_modules/n8n-nodes-caldav-pro` out of your n8n container.

## 1. What your copy actually is

| Check | Result |
| --- | --- |
| Version | `3.5.0` |
| `dist/` vs the published npm `n8n-nodes-caldav-pro@3.5.0` | **byte-identical** (`diff -r` clean, all 9 JS files + maps) |
| `README.md`, `CHANGELOG.md` vs npm 3.5.0 | identical |
| Bundled deps | `fast-xml-parser@5.11.1`, `ical.js@2.2.1` — both present and correct |
| `package.json` | same except `devDependencies` and `peerDependencies` are stripped (normal for an installed copy, harmless) |
| Node registration | `dist/nodes/CalDav/CalDav.node.js` + both credentials — correct |

**So your install is not corrupted, not stale, and not modified.** It is stock 3.5.0 — which means it
has exactly the behaviour I described, and none of the fixes from the patch.

## 2. Same problem, reproduced on *your* build

I loaded your compiled `dist/nodes/CalDav/CalDav.node.js` (not the source, not npm — the files from
your repo) and executed it against a live CalDAV server:

```
resource options      : Calendar=calendar, Event=event, ICS Feed (Read-Only)=icsFeed
resource default      : event
calendar notice field : false          ← the warning from the patch is absent, as expected on 3.5.0
operations for ["calendar"]: "Get Many" (getAll)
operations for ["event"]   : "Create", "Delete", "Get", "Get Many", "Get Next", "Move", "Search", "Update"

--- RESOURCE = calendar, operation = getAll
    {"url":".../bob/home/","displayName":"Home","readOnly":false}
    {"url":".../bob/work/","displayName":"Work","readOnly":false}      ← your symptom

--- RESOURCE = event, operation = getAll
    {"uid":"demo-1","summary":"Standup","start":"2026-09-10T09:00:00.000Z",
     "startLocal":"2026-09-10T11:00:00+02:00", ...}                    ← events, correct

--- RESOURCE = event, operation = getNext        ← 11 events incl. expanded recurrences, correct
```

Both confirmed on your binary: **the calendar list comes only from Resource = Calendar**, and
Event works fine on the very build you are running. Nothing to repair in the container itself.

I also reproduced bug 3.1 from the review on your build:

```
--- Get Many with Time Min / Time Max not supplied:
    Time Min is not a valid date: "undefined"
```

(on the patched build the same call answers `no error`).

## 3. What to correct — in order

### a) The workflow node (this is the actual fix, 10 seconds)

In the CalDAV node: **Resource → Event**, then **Operation → Get Many** (fixed window),
**Get Next** (upcoming) or **Search**. Then set **Calendar** (a specific one, *🏠 Default Calendar*
or *⭐ All Calendars*) and **Time Min / Time Max**.

*Calendar → Get Many* is only for discovering calendar names/URLs; it never returns events, and it
is the resource that sorts first in the dropdown, which is how it gets picked by accident.

### b) Optional — install the patched build so it can't happen again

`n8n-nodes-caldav-pro-3.5.1.tgz` in this workspace is the same package with the review fixes
(Calendar-resource warning notice, resource descriptions, parameter fallbacks, duplicate-UID
message, corrected AI-Agent docs). Built, linted, `check:package` clean, 287 tests passing, and
smoke-tested against a real CalDAV server.

```bash
# from the host, with your n8n container called "n8n"
docker cp n8n-nodes-caldav-pro-3.5.1.tgz n8n:/tmp/

docker exec -u node n8n sh -lc \
  'cd /home/node/.n8n/nodes && npm install /tmp/n8n-nodes-caldav-pro-3.5.1.tgz'

docker restart n8n
```

Check afterwards in **Settings → Community nodes** that it reads `3.5.1`. The package name and the
node type (`n8n-nodes-caldav-pro.calDav`) are unchanged, so existing workflows keep working.

Minimal alternative — only **two** files actually differ from your copy:

```
dist/nodes/CalDav/CalDav.node.js
dist/nodes/CalDav/CalendarDescription.js
```

Copying those two (plus their `.map`s) into
`/home/node/.n8n/nodes/node_modules/n8n-nodes-caldav-pro/dist/nodes/CalDav/` and restarting n8n has
the same effect, if you would rather not touch the install.

> n8n reads node descriptions once at process start — after either route you **must restart the
> container**, and reload the browser tab (the editor caches node types too).

### c) Container timezone — worth fixing while you are in there

The node reads the *workflow* timezone for `startLocal`/`endLocal` and for the `$now`-based Time Min
/ Time Max defaults. n8n's fallback is `America/New_York`, not the host clock, so on a default
container a "today" window starts at 06:00 Paris time and events stored in plain UTC are rendered in
New York time. In your compose file:

```yaml
environment:
  - GENERIC_TIMEZONE=Europe/Paris
  - TZ=Europe/Paris
```

(or set the timezone per workflow in Workflow → Settings → Timezone).

### d) If you drive it from an AI Agent

Section 4 of `CALDAV-NODE-REVIEW.md` applies unchanged and matters more there: the model cannot
choose Resource or Operation (both are `noDataExpression`), so one tool node = one operation. A tool
node left on *Calendar → Get Many* answers every single prompt with the calendar list. Use one
renamed node per operation, each with **Description → Set manually**, and `$fromAI()` in the value
fields.

## 4. Files in this workspace

- `n8n-nodes-caldav-pro-3.5.1.tgz` — drop-in patched package for the container.
- `caldav-pro-fixes.patch` — the source diff, if you prefer to build it yourself (or to send
  upstream to `Daisytwo/n8n-nodes-caldav-pro` as a PR — the fixes are generic, not specific to you).
- `CALDAV-NODE-REVIEW.md` — the full review.
