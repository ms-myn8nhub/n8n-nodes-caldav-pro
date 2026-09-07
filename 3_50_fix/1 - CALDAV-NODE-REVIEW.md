# Code review — `n8n-nodes-caldav-pro` @ 3.5.0 (commit `9c40448`)

**Reported:** "Get events" only shows the list of calendars, and the same happens for other commands.

**Diagnosis (confirmed with you):** the node was running with **Resource = Calendar**. That resource
has exactly one operation — *Get Many* — and it lists calendars, never events. Because *Event* also
has an operation labelled *Get Many*, and because the node header/subtitle only shows the operation
verb, switching operations while Resource stays on *Calendar* keeps returning the same calendar
list — "the same thing happens for other commands".

**So: no CalDAV bug.** I verified that separately (§1). What the node *did* do wrong is let you land
there without ever saying so, which is a real UI defect for a node whose two resources share the
label "Get Many". §2 is the fix for that, §3 the other bugs I found while reading, §4 the AI-Agent
version of the same trap (worth reading before you wire this into an Agent — it is unavoidable
there).

**Your immediate fix:** in the node, set **Resource = Event**, then choose *Get Many* (window),
*Get Next* (upcoming) or *Search*. Pick a Calendar (or *🏠 Default Calendar (From Credentials)*, or
*⭐ All Calendars*) and set Time Min / Time Max.

---

## 1. What I verified (so we can rule it out)

I cloned the repo, installed it, and executed the real `CalDav.execute()` against a live
**Radicale 3.8** CalDAV server (two calendars, "Work" and "Home"), with a context that performs
genuine HTTP with Basic auth — i.e. the same request chain n8n makes.

| Operation | Result |
| --- | --- |
| Calendar → Get Many | ✅ 2 calendars, `readOnly` detected |
| Event → Get Many (one calendar / All Calendars / Default Calendar) | ✅ events only, sorted, `calendarUrl`/`calendarName` attached |
| Event → Get Next | ✅ recurring series expanded into occurrences |
| Event → Search | ✅ matched title/description/location, cross-calendar |
| Event → Get / Create / Update / Move | ✅ incl. events stored under a filename ≠ UID (UID lookup via `calendar-query` works) |
| Event → Update / Delete of a single occurrence | ✅ `RECURRENCE-ID` override and `EXDATE` written correctly |
| Delete of a whole series without "Entire Series" | ✅ correctly refused |
| TZID + VTIMEZONE event, all-day event, wall-clock + Timezone create | ✅ `start`/`end` (UTC) and `startLocal`/`endLocal` (offset) all correct under host TZ = UTC |

Also clean: `tsc --noEmit`, `eslint nodes credentials`, and the existing 284 unit tests.

I additionally simulated n8n's own parameter resolution (`NodeHelpers.displayParameter` /
`getNodeParameters`) against the node description for every resource/operation combination. The
`displayOptions` are correct — no field is shown or hidden wrongly, and the three duplicate
`operation` properties (calendar / event / icsFeed) resolve exactly as n8n expects.

**Conclusion:** with Resource = *Event* the node cannot return calendars. Something upstream is
selecting Resource = *Calendar*.

---

## 2. Fix in the node: make the Calendar resource impossible to mistake (patched)

The trap is structural, not a typo:

- both `calendar` and `event` expose an operation whose label is literally **"Get Many"** (the n8n
  lint rule `node-param-option-name-wrong-for-get-many` forces that exact wording, so the label
  alone can never distinguish them);
- *Calendar* sorts first in the Resource dropdown and its action, *"Get many calendars"*, sorts near
  the top of the node-creator action list;
- the canvas subtitle is `operation + ": " + resource`, so a node stuck on the calendar resource
  reads `getAll: calendar` — technically correct, easy to skim past;
- nothing in the panel told you the output would contain no events.

Patched in `CalendarDescription.ts` / `CalDav.node.ts`:

1. **A notice, shown whenever Resource = Calendar**, right under the Operation field:
   > *This returns your **calendars**, not their contents. To read events — "what is on tomorrow",
   > "the next meeting", a keyword search — set **Resource** to **Event** and use Get Many, Get Next
   > or Search there.*
2. **Descriptions on the three Resource options**, so the dropdown itself explains the difference
   ("The calendars themselves: their names, URLs and colours. Returns no events…" vs "The events
   inside a calendar…").
3. **The Calendar operation's action** in the node-creator list is now
   *"Get many calendars not their events"* (the wording is constrained by the lint rules — sentence
   case, no parentheses — but it no longer reads as a way to fetch events), and its description
   spells out what the records contain.

Nothing about behaviour, parameter names or values changed, so existing workflows are unaffected.

## 3. Real bugs found while reading (patched)

### 3.1 Hidden parameters crash operations driven by an expression — `CalDav.node.ts`

`calendar`, `returnAll`, `limit`, `timeMin`, `timeMax`, `query` and `targetCalendar` were read
**without a fallback**:

```ts
const raw = this.getNodeParameter(parameter, itemIndex) as string;   // timeMin / timeMax
const calendarUrl = this.getNodeParameter('calendar', i) as string;
const returnAll = this.getNodeParameter('returnAll', i) as boolean;
```

A parameter that is not *displayed* for the current resource/operation is absent from the resolved
parameters, so n8n throws `Could not get parameter "timeMin"` — or, worse, `new Date(undefined)`
becomes `NaN` and reaches the REPORT body. That is precisely what happens as soon as `Operation`
is driven by an expression (every field whose `displayOptions` mention `operation` stops being
displayed). Every one of them now has a sane fallback; Time Min / Time Max fall back to
*now → now + 7 days*, matching the UI defaults.

### 3.2 Create with an existing UID returns an opaque error — `CalDav.node.ts`

`PUT` with `If-None-Match: *` answers `412` when the resource already exists. That was passed
through untouched and n8n rendered it as:

> Your request is invalid or could not be processed by the service

Reproduced live. It now says which UID collided and what to do about it (leave UID empty, use a
different one, or use Update) — the same treatment `403` and the update/delete `412` already got.

### 3.3 `Unknown resource/operation` errors don't say what *is* valid — `CalDav.node.ts`

Made the three messages list the valid values and, for the resource one, note that Resource and
Operation cannot be filled by an agent. This is the error a mis-wired agent setup actually hits.

### 3.4 Docs — `README.md`

"AI Agent Usage" rewritten per §4 (the old text claimed the agent picks resource/operation, which
n8n does not allow).

Tests added in `test/parameterFallbacks.test.ts` (3 new tests). Full suite: **287 passing**,
`tsc` and `eslint` clean.

---

## 4. The same trap, unavoidable in the AI-Agent path

Read this before you attach the node to an Agent: there the mix-up cannot be fixed by picking the
right Resource, because the model never gets to pick one. It also explains "…and the same thing happens for other commands"
perfectly.

### 4.1 The model cannot pick Resource or Operation

`Resource` and `Operation` are declared `noDataExpression: true`
(`CalDav.node.ts`, `CalendarDescription.ts`, `EventDescription.ts`, `IcsFeedDescription.ts`).
That flag removes the expression toggle, so those two fields can never contain `$fromAI()`.

n8n builds a tool's input schema **only** from `$fromAI()` placeholders it finds in the node's
stored parameters (`packages/core/.../create-node-as-tool.ts` → `getSchema()` →
`traverseNodeParameters`). Resource and Operation are therefore *always* what you set in the node.

➡️ **One CalDAV tool node = exactly one operation.** If the tool node sits on
*Calendar → Get Many*, then "what's on tomorrow?", "create a meeting", "delete the dentist" — every
prompt — executes *Calendar → Get Many* and the agent gets the calendar list back. That is exactly
the reported symptom, for every command.

### 4.2 The auto tool description makes it worse

With *Description → Auto*, n8n derives the text the model sees from
`NodeHelpers.makeDescription()`, which returns just `"<action> in <node default name>"` — e.g.
**"Get many calendars in CalDAV"**. The long, carefully written node description (the
`startLocal` vs `start` guidance and every field hint) is **discarded**. If several CalDAV tool
nodes are attached and they are all still named `CalDAV`, `CalDAV1`, `CalDAV2`, the model is
choosing between near-identical one-liners and will happily call the calendar one for everything.

### 4.3 The README currently promises the opposite

> "The agent will populate: `resource` = `event`, `operation` = `create` …"

That is not possible in n8n and is, I think, the reason the node was wired the way it was. Fixed in
the patch.

### ✅ How to wire it (no code change needed)

Give the agent **one node per operation**, each renamed (the node name *is* the tool name the model
sees) and each with **Description → Set manually**:

| Node name (tool name) | Resource / Operation | `$fromAI()` fields |
| --- | --- | --- |
| `calendar_list` | Calendar / Get Many | — |
| `events_in_range` | Event / Get Many | Time Min, Time Max |
| `next_events` | Event / Get Next | Lookahead Days |
| `search_events` | Event / Search | Query, Time Min, Time Max |
| `create_event` | Event / Create | Summary, Start, End, Additional Fields |
| `update_event` | Event / Update | Event URL (or UID), Summary, Start, End |
| `delete_event` | Event / Delete | Event URL (or UID), Occurrence |

Example, on *Event → Get Many → Time Min*:

```
={{ $fromAI('timeMin', 'Start of the window, ISO 8601 with offset', 'string') }}
```

Keep **Calendar** on a fixed pick (or *🏠 Default Calendar*) unless the agent really must choose —
a model inventing a calendar URL is the usual cause of 404s afterwards.

Add to the system prompt:

```
To answer "what is on <date>", call events_in_range.
calendar_list only returns calendar names and never contains any event.
```

## 5. Smaller observations (not patched — your call)

- **`resource`/`operation` are read at item 0 only** (`getNodeParameter('resource', 0)`), while
  `calendar`, dates etc. are read per item. Deliberate and normal, but it means an expression that
  varies per item silently uses item 0's value for those two.
- **`limit` is applied after the fetch.** For *All Calendars* + `limit: 5` the node still REPORTs
  every calendar and expands every series. Fine for personal calendars, noticeable on large ones.
- **Search does client-side filtering** (documented), so `limit` also applies post-filter — correct,
  just worth knowing it costs a full window fetch.
- **`collectEvents` sorts with `String.localeCompare`,** mixing `"2026-09-12"` (all-day) with
  `"2026-09-12T09:00:00.000Z"`. It happens to order correctly because the date prefix is identical,
  but an explicit comparator would be less accidental.
- **Update of a single occurrence drops the series `rrule` from the returned record** (the override
  VEVENT legitimately has no RRULE). Correct on the wire, mildly surprising in the output.
- **`.well-known/caldav` failures are swallowed silently** at debug level. Good for robustness,
  but on a server that 302s to `http://` (Infomaniak) the only trace is a debug log.

---

## 6. Files

- `caldav-pro-fixes.patch` — the whole change set, 4 files. Apply in a clean checkout with
  `git apply caldav-pro-fixes.patch`, then `npm run build`.
- `/home/user/n8n-nodes-caldav-pro` — the clone on branch `review-fixes`, fixes applied, with
  `npm test` (287 passing), `npm run lint`, `npm run lint:selftest`, `tsc --noEmit` and
  `npm run check:package` all green.

### Verifying it yourself

The fastest honest test rig, and the one I used, is a throwaway CalDAV server rather than mocks:

```bash
pip install radicale && python -m radicale --storage-filesystem-folder /tmp/dav \
  --auth-type none --server-hosts 127.0.0.1:5232
curl -X MKCALENDAR -u bob:x http://127.0.0.1:5232/bob/work/
```

Point the credential at `http://127.0.0.1:5232/` with any username, and every operation is
exercised against real CalDAV XML, real ETags and real recurrence expansion.
