# Root cause found — the credential declaration was hijacking the Resource field

Your screenshot is the missing piece. That **Calendar / Event / ICS Feed (Read-Only)** dropdown in the
top-right of the *credential* modal is not a credential setting the node author put there — it is
n8n's **credential "setup" selector**, and n8n generates it automatically from the node's credential
declaration. In 3.5.0/3.5.1 that declaration reads:

```ts
credentials: [
  { name: 'calDavApi',  required: true, displayOptions: { show: { resource: ['calendar', 'event'] } } },
  { name: 'icsFeedApi', required: true, displayOptions: { show: { resource: ['icsFeed'] } } },
]
```

Because the credentials are gated on `resource`, the editor promotes **Resource** to the role of
credential discriminator (the slot normally filled by an `authentication` property). Two consequences,
and they match your observations exactly:

1. **Resource is removed from the Parameters pane** and rendered as that dropdown in the credential
   modal instead — which is why you saw no Resource field on the node.
2. **`calendar` and `event` map to the same credential type** (`calDavApi`), so the selector has
   nothing to switch to: choosing *Event* would select the credential type that is already selected.
   The entry is displayed but inert — "cannot be selected", exactly as you marked it — and the node
   stays on the first matching value, `calendar`.

That is also why removing the credential frees everything up: with no credential attached there is no
setup selector, so Resource falls back to being an ordinary parameter with all three options.

So this is a **node-packaging bug**, not a Synology, Docker, Postgres or leftover-package problem —
consistent with your clean search for `n8n-nodes-caldav`.

## The fix (in `n8n-nodes-caldav-pro-3.5.2.tgz`)

The credentials are no longer gated on `resource`:

```ts
credentials: [
  { name: 'calDavApi',  required: false },
  { name: 'icsFeedApi', required: false },
]
```

No `displayOptions` → no setup selector → **Resource stays a normal node parameter** with Calendar,
Event and ICS Feed all selectable, credential attached or not. `required: false` keeps the feed-only
setup working (an ICS feed needs no CalDAV account); `execute()` now enforces the right credential
itself and fails with a readable message instead of n8n's generic one:

```
No CalDAV API credential selected
Resource "event" authenticates with the CalDAV API credential. Open the node, and in the
Credential field pick or create a CalDAV API credential.
```

Verified on the packed tarball against a live CalDAV server:

```
version in package    : 3.5.2
credentials           : [{"name":"calDavApi","required":false,"gated":false},
                         {"name":"icsFeedApi","required":false,"gated":false}]
resource param        : present, default=event, gated=false
calendar notice field : true

--- resource=event,    operation=getAll → 9 event items, first summary = Standup
--- resource=calendar, operation=getAll → Home, Work
--- resource=event with NO credential   → "No CalDAV API credential selected" + instructions
```

288/288 tests pass (three now assert that neither credential is gated and that Resource stays an
always-visible parameter, so this cannot regress), lint and `check:package` clean.

### Install on the NAS

```bash
docker cp n8n-nodes-caldav-pro-3.5.2.tgz n8n:/tmp/
docker exec -u node n8n sh -lc 'cd /home/node/.n8n/nodes && npm install /tmp/n8n-nodes-caldav-pro-3.5.2.tgz'
docker restart n8n
```

Then **hard-reload the browser** (Ctrl-Shift-R) — the editor caches node descriptions, and this fix is
entirely in the description.

Your existing **CalDAV - AbC** credential stays valid: the credential type (`calDavApi`) and its
fields are unchanged, only the node's declaration of it changed. Nodes already on the canvas that were
forced to `resource: calendar` keep that stored value — open each one and switch Resource to Event
(the dropdown will be there again).

## If you cannot install right now

Import `workflows/caldav-event-preset.json` — its nodes already carry `resource: event`. Careful:
picking the credential in the node panel on 3.5.0/3.5.1 is what rewrites Resource back to `calendar`,
so wire the credential in the JSON instead of in the UI.

Get the credential's id (also visible in the URL when you open it: `…/home/credentials/<id>`):

```bash
docker exec -i n8n-postgres psql -U n8n -d n8n <<'SQL'
SELECT id, name, type FROM credentials_entity WHERE type = 'calDavApi';
SQL
```

Then fill in `workflows/caldav-event-preset-with-credential.json`, which has the block ready on every
CalDAV node:

```json
"credentials": {
  "calDavApi": { "id": "__CALDAV_CREDENTIAL_ID__", "name": "__CALDAV_CREDENTIAL_NAME__" }
}
```

```bash
sed -e 's/__CALDAV_CREDENTIAL_ID__/PASTE_ID_HERE/g' \
    -e 's/__CALDAV_CREDENTIAL_NAME__/CalDAV - AbC/g' \
    caldav-event-preset-with-credential.json > caldav-ready.json
```

Import `caldav-ready.json` (⋯ → Import from File…) and run it without opening the credential picker.

## Worth reporting upstream

This affects every user of the published package, not just you. `caldav-pro-fixes.patch` plus the
3.5.2 source in this workspace can go to `Daisytwo/n8n-nodes-caldav-pro` as a PR; the one-line summary
for the issue is:

> Declaring `credentials` with `displayOptions.show.resource` turns Resource into the credential setup
> selector; since `calendar` and `event` share `calDavApi`, Event becomes unselectable and the node is
> locked to listing calendars whenever a credential is attached.
