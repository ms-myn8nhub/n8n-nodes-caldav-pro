import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, ILoadOptionsFunctions } from 'n8n-workflow';
// ical.js is a CommonJS module; default import works under esModuleInterop.
import ICAL from 'ical.js';

import { expandCalendarObject, simplifyEvent, type CalDavEvent } from './GenericFunctions';

/**
 * External ICS feeds: a read-only path that shares no code with CalDAV.
 *
 * Everything here runs unauthenticated and against a host the user names in a
 * credential, so it is the one place in this node where an arbitrary address is
 * fetched. Two rules follow from that and are enforced below rather than by
 * convention:
 *
 *   1. The request never goes through `davRequest` or
 *      `httpRequestWithAuthentication`. No CalDAV password, no cookie, and no
 *      credential of any kind may ride along on a request aimed at a host the
 *      CalDAV credential knows nothing about.
 *   2. Nothing derived from the feed URL reaches an output field, an error
 *      message, or a log line. A feed URL is itself a secret: providers hand out
 *      subscription links with the access token in the path or query, so
 *      quoting one back into a workflow's output or an agent's context leaks
 *      read access to the whole calendar.
 *
 * What this cannot do is stop a host that resolves to a private address at
 * connect time — the name is checked here, the resolution happens later in the
 * HTTP client, so a DNS answer that changes in between is not caught. Restrict
 * egress from the n8n host if that matters to you.
 */

type FeedCtx = IExecuteFunctions | ILoadOptionsFunctions;

/** The largest feed body this node reads, in bytes. */
export const MAX_FEED_BYTES = 5 * 1024 * 1024;

/** How many redirects are followed before the fetch is given up on. */
export const MAX_FEED_REDIRECTS = 3;

const FEED_TIMEOUT_MS = 30_000;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Host suffixes that never name something on the public internet. `arpa` covers
 * both `home.arpa` and the `in-addr.arpa` / `ip6.arpa` reverse-lookup trees.
 */
const PRIVATE_TLDS = new Set([
	'localhost',
	'local',
	'localdomain',
	'internal',
	'intranet',
	'lan',
	'home',
	'corp',
	'private',
	'arpa',
]);

/** One DNS label: letters, digits and inner hyphens. */
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * A public host's last label is alphabetic. Every notation for an IP literal —
 * dotted quad, hex, decimal, octal, shorthand — is normalised by the URL parser
 * into a dotted quad, whose last label is numeric, so this one rule covers them
 * all without trying to enumerate the notations.
 */
const PUBLIC_TLD = /^[a-z][a-z0-9-]*$/;

/**
 * A rejection the user is allowed to see. Every message is written here in full
 * rather than composed from the input, so no caller can accidentally interpolate
 * the feed URL into one.
 */
function feedError(message: string): Error {
	return new Error(message);
}

/**
 * Validate a feed address and return the URL that will actually be requested.
 *
 * `subject` names what is being checked, so the same rules can report on the
 * credential's Feed URL and on a `Location` header without either message
 * quoting the address it rejected.
 */
export function assertSafeFeedUrl(input: string, subject = 'The Feed URL'): string {
	const trimmed = String(input ?? '').trim();
	if (!trimmed) {
		throw feedError(
			'No Feed URL is configured. Open the ICS Feed credential and paste the calendar\'s subscription link.',
		);
	}

	// webcal:// and webcals:// are the subscription schemes calendar apps
	// register; both are plain HTTPS on the wire. Rewritten as text, before the
	// URL parser sees them: it treats unknown schemes as opaque and would not
	// parse out a host to check.
	const candidate = trimmed.replace(/^webcals?:\/\//i, 'https://');

	if (!/^https:\/\//i.test(candidate)) {
		throw feedError(
			`${subject} must be an HTTPS or webcal address. Other schemes are refused.`,
		);
	}

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw feedError(`${subject} is not a valid URL.`);
	}

	if (url.protocol !== 'https:') {
		throw feedError(`${subject} must be an HTTPS or webcal address. Other schemes are refused.`);
	}
	if (url.username || url.password) {
		throw feedError(
			`${subject} must not contain a username or password. This node reads public feeds only.`,
		);
	}
	// The URL parser drops an explicit :443, so anything left is a non-standard
	// port — the usual shape of an SSRF probe at an internal service.
	if (url.port) {
		throw feedError(`${subject} must use the standard HTTPS port 443.`);
	}
	if (!isPublicHostname(url.hostname)) {
		throw feedError(
			`${subject} must name a public host. IP addresses and local or private network names are refused.`,
		);
	}
	return url.toString();
}

function isPublicHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	// Brackets mean an IPv6 literal; a colon anywhere is not a host name.
	if (!host || host.length > 253 || /[[\]:]/.test(host)) return false;
	const labels = host.split('.');
	// A single label is either a machine on the local network or a search-domain
	// lookup, never a public feed.
	if (labels.length < 2) return false;
	if (!labels.every((label) => label.length <= 63 && HOST_LABEL.test(label))) return false;
	const tld = labels[labels.length - 1];
	if (!PUBLIC_TLD.test(tld)) return false;
	return !PRIVATE_TLDS.has(tld);
}

/**
 * Per-execution memo for feed bodies.
 *
 * Keyed on the execution context, exactly as the CalDAV calendar list is, so a
 * node run over 50 input items fetches the feed once and the entry is collected
 * when the run ends.
 */
const feedCache = new WeakMap<object, Map<string, Promise<string>>>();

/**
 * Fetch a feed body. Validates first, so an address that fails the guard never
 * reaches the HTTP client, and memoises per execution.
 */
export async function fetchIcsFeed(this: FeedCtx, feedUrl: string): Promise<string> {
	const url = assertSafeFeedUrl(feedUrl);

	let perContext = feedCache.get(this);
	if (!perContext) {
		perContext = new Map();
		feedCache.set(this, perContext);
	}
	const cached = perContext.get(url);
	if (cached) return cached;

	const pending = fetchIcsFeedUncached.call(this, url);
	perContext.set(url, pending);
	// A transient failure must not be replayed for the rest of the run.
	pending.catch(() => perContext.delete(url));
	return pending;
}

function headerValue(
	headers: Record<string, string | string[]> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const key = Object.keys(headers).find((h) => h.toLowerCase() === name);
	if (!key) return undefined;
	const value = headers[key];
	return Array.isArray(value) ? value[0] : value;
}

async function fetchIcsFeedUncached(this: FeedCtx, startUrl: string): Promise<string> {
	const origin = new URL(startUrl).origin;
	let url = startUrl;

	for (let hop = 0; hop <= MAX_FEED_REDIRECTS; hop++) {
		const response = await requestFeed.call(this, url);
		const status = Number(response.statusCode);

		if (REDIRECT_STATUS.has(status)) {
			url = nextHop(headerValue(response.headers, 'location'), url, origin);
			continue;
		}
		if (status < 200 || status >= 300) throw statusError(status);

		const declared = Number(headerValue(response.headers, 'content-length'));
		if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) throw tooLargeError();

		const body = typeof response.body === 'string' ? response.body : String(response.body ?? '');
		if (Buffer.byteLength(body, 'utf8') > MAX_FEED_BYTES) throw tooLargeError();

		// A feed URL that has expired or needs a login usually answers 200 with a
		// sign-in page, so the status code alone does not say we got a calendar.
		const text = body.replace(/^\ufeff/, '');
		if (!/BEGIN:VCALENDAR/i.test(text)) {
			throw feedError(
				'The feed did not return an iCalendar document — no BEGIN:VCALENDAR in the response. ' +
					'If the address opens a web page in a browser, copy the calendar\'s subscription (ICS) link instead.',
			);
		}
		return text;
	}

	throw feedError(
		`The feed redirected more than ${MAX_FEED_REDIRECTS} times, so the fetch was given up on.`,
	);
}

/** Where a redirect points, once it has passed the same checks as the feed URL. */
function nextHop(location: string | undefined, current: string, origin: string): string {
	if (!location) {
		throw feedError('The feed server sent a redirect without a destination.');
	}
	let resolved: string;
	try {
		resolved = new URL(location, current).toString();
	} catch {
		throw feedError('The feed server redirected to an address that is not a valid URL.');
	}
	// Re-run the full guard on every hop: a redirect chain is the standard way
	// to turn an allowed address into an internal one.
	const checked = assertSafeFeedUrl(resolved, 'The redirect target');
	if (new URL(checked).origin !== origin) {
		throw feedError(
			'The feed server redirected to a different origin. Only redirects that stay on the same host and port are followed.',
		);
	}
	return checked;
}

async function requestFeed(
	this: FeedCtx,
	url: string,
): Promise<{ statusCode: number; headers: Record<string, string | string[]>; body: string }> {
	const options: IHttpRequestOptions = {
		method: 'GET',
		url,
		headers: {
			Accept: 'text/calendar, text/plain;q=0.5',
		},
		// Redirects are followed by hand below so every hop can be re-validated;
		// the client must not quietly follow one to an address we would refuse.
		disableFollowRedirect: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		json: false,
		encoding: 'text',
		timeout: FEED_TIMEOUT_MS,
	};
	try {
		// helpers.httpRequest, never httpRequestWithAuthentication: this request
		// must carry no credential at all.
		return (await this.helpers.httpRequest(options)) as {
			statusCode: number;
			headers: Record<string, string | string[]>;
			body: string;
		};
	} catch (error) {
		// The client's own message names the host it failed to reach
		// ("getaddrinfo ENOTFOUND feeds.example.com"), so only the code is read.
		throw feedError(`The ICS feed could not be fetched: ${transportReason(error)}.`);
	}
}

function transportReason(error: unknown): string {
	const err = error as { code?: unknown; cause?: { code?: unknown } };
	const code = String(err?.code ?? err?.cause?.code ?? '');
	if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) return 'the feed host could not be resolved';
	if (/^(ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED)$/.test(code)) {
		return 'the feed server did not answer in time';
	}
	if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)$/.test(code)) {
		return 'the connection to the feed server failed';
	}
	if (/^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_TLS)/.test(code)) {
		return 'the feed server\'s TLS certificate was rejected';
	}
	return 'the request did not complete';
}

function tooLargeError(): Error {
	return feedError(
		'The feed is larger than the 5 MB this node reads. Narrow the subscription at the provider, or use the CalDAV resource, which asks the server for one time window at a time.',
	);
}

function statusError(status: number): Error {
	if (status === 401 || status === 403) {
		return feedError(
			`The feed refused the request (HTTP ${status}). This node reads public feeds only and sends no credentials — use the CalDAV resource for a calendar that needs a login.`,
		);
	}
	if (status === 404 || status === 410) {
		return feedError(
			`The feed was not found (HTTP ${status}). Re-copy the subscription link from the provider; these often expire.`,
		);
	}
	if (status === 429) {
		return feedError('The feed server is rate-limiting this node (HTTP 429). Try again later.');
	}
	return feedError(`The feed request failed with HTTP ${status}.`);
}

/* ─────────────── feed parsing ─────────────── */

const FEED_PRODID = '-//Daisytwo//n8n-nodes-caldav-pro//EN';

/**
 * Split a feed into one calendar object per event, the shape a CalDAV server
 * returns for a single resource.
 *
 * The point is to reach `expandCalendarObject` — the same recurrence, EXDATE,
 * override, all-day and timezone handling the CalDAV path uses — with input it
 * already understands, instead of a second parser that would drift from it. Each
 * object carries only the VTIMEZONE components its own events reference, so an
 * event with a non-IANA TZID still resolves.
 */
export function splitFeedObjects(body: string): string[] {
	let comp: any;
	try {
		comp = new ICAL.Component(ICAL.parse(body));
	} catch {
		throw feedError('The feed is not a valid iCalendar document and could not be parsed.');
	}
	const vevents = comp.getAllSubcomponents('vevent');
	if (!vevents.length) return [];

	const zones = new Map<string, string>();
	for (const vtimezone of comp.getAllSubcomponents('vtimezone')) {
		const tzid = vtimezone.getFirstPropertyValue('tzid');
		if (tzid) zones.set(String(tzid), vtimezone.toString());
	}

	// One object per UID: a series master and its RECURRENCE-ID overrides have to
	// stay together, or the overrides are reported as separate events.
	const groups = new Map<string, any[]>();
	vevents.forEach((vevent: any, index: number) => {
		const uid = vevent.getFirstPropertyValue('uid');
		const key = uid ? String(uid) : ` ${index}`;
		const existing = groups.get(key);
		if (existing) existing.push(vevent);
		else groups.set(key, [vevent]);
	});

	const objects: string[] = [];
	for (const group of groups.values()) {
		const tzids = new Set<string>();
		for (const vevent of group) {
			for (const property of vevent.getAllProperties()) {
				const tzid = property.getParameter('tzid');
				if (tzid) tzids.add(String(tzid));
			}
		}
		objects.push(
			[
				'BEGIN:VCALENDAR',
				'VERSION:2.0',
				`PRODID:${FEED_PRODID}`,
				...[...tzids].map((tzid) => zones.get(tzid)).filter(Boolean),
				...group.map((vevent: any) => vevent.toString()),
				'END:VCALENDAR',
			].join('\r\n') + '\r\n',
		);
	}
	return objects;
}

/**
 * Whether an event overlaps the requested window.
 *
 * CalDAV leaves this to the server's time-range filter. A feed is one flat file
 * of everything the calendar holds, so the same selection has to happen here —
 * without it, Time Min / Time Max would be ignored for non-recurring events.
 */
export function eventInWindow(event: CalDavEvent, rangeStart: Date, rangeEnd: Date): boolean {
	const start = event.start ? Date.parse(event.start) : NaN;
	// An event we cannot place is kept: dropping it would hide it entirely.
	if (!Number.isFinite(start)) return true;
	const parsedEnd = event.end ? Date.parse(event.end) : NaN;
	// A zero-length event still occupies its start instant.
	const end = Number.isFinite(parsedEnd) && parsedEnd > start ? parsedEnd : start + 1;
	return end > rangeStart.getTime() && start < rangeEnd.getTime();
}

/**
 * Turn a feed body into event records, expanding recurrence inside the window
 * and dropping everything outside it.
 */
export function expandIcsFeed(
	body: string,
	rangeStart: Date,
	rangeEnd: Date,
	localZone?: string,
): CalDavEvent[] {
	const events: CalDavEvent[] = [];
	for (const object of splitFeedObjects(body)) {
		// The URL is deliberately empty: a feed event has no addressable resource,
		// and the feed's own URL must never reach an output field.
		for (const event of expandCalendarObject(object, '', undefined, rangeStart, rangeEnd, localZone)) {
			if (eventInWindow(event, rangeStart, rangeEnd)) events.push(event);
		}
	}
	return events;
}

/**
 * Shape one feed event for output.
 *
 * `url` and `etag` are dropped rather than blanked: they exist on a CalDAV event
 * because it can be addressed and written back, neither of which is true here,
 * and `url` is where the feed address would otherwise surface. `source` and
 * `feedName` take their place so a workflow — or an agent reading the output —
 * can still tell where the event came from.
 */
export function toFeedEvent(
	event: CalDavEvent,
	feedName: string | undefined,
	simplify: boolean,
): IDataObject {
	const record: Partial<CalDavEvent> = simplify ? { ...simplifyEvent(event) } : { ...event };
	delete record.url;
	delete record.etag;
	return {
		...(record as unknown as IDataObject),
		source: 'icsFeed',
		...(feedName ? { feedName } : {}),
	};
}
