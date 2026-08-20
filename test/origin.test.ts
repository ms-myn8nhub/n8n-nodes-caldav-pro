import { describe, expect, it, vi } from 'vitest';
import { CalDav } from '../nodes/CalDav/CalDav.node';
import {
	absoluteUrl,
	resolveDefaultCalendar,
	resolveEventUrl,
} from '../nodes/CalDav/GenericFunctions';

const SERVER = 'https://dav.example.com/';
const WORK = 'https://dav.example.com/calendars/bob/work/';
const OTHER = 'https://dav.example.com/calendars/bob/other/';

/**
 * A context whose HTTP helper records every request and answers everything
 * plausibly. The point of most tests here is that it is never called at all.
 */
function makeContext(params: Record<string, unknown>, credentials: Record<string, unknown> = {}) {
	const requests: Array<{ method: string; url: string }> = [];
	const httpRequestWithAuthentication = vi.fn(async (_cred: string, o: any) => {
		requests.push({ method: o.method, url: String(o.url) });
		if (o.method === 'PROPFIND') {
			const body = String(o.body ?? '');
			if (body.includes('current-user-principal')) {
				return {
					statusCode: 207,
					headers: {},
					body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:current-user-principal><d:href>/principals/bob/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`,
				};
			}
			if (body.includes('calendar-home-set')) {
				return {
					statusCode: 207,
					headers: {},
					body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/bob/</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><c:calendar-home-set><d:href>/calendars/bob/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`,
				};
			}
			return {
				statusCode: 207,
				headers: {},
				body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/bob/work/</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work</d:displayname></d:prop></d:propstat></d:response></d:multistatus>`,
			};
		}
		if (o.method === 'GET') {
			return {
				statusCode: 200,
				headers: { etag: '"stored-1"' },
				body: [
					'BEGIN:VCALENDAR',
					'VERSION:2.0',
					'PRODID:-//x//EN',
					'BEGIN:VEVENT',
					'UID:e1',
					'DTSTAMP:20260101T000000Z',
					'DTSTART:20260420T100000Z',
					'DTEND:20260420T110000Z',
					'SUMMARY:Stored',
					'END:VEVENT',
					'END:VCALENDAR',
				].join('\r\n'),
			};
		}
		if (o.method === 'REPORT') {
			return {
				statusCode: 207,
				headers: {},
				body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>',
			};
		}
		return { statusCode: 201, headers: { etag: '"w1"' }, body: '' };
	});

	return {
		requests,
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'CalDAV', type: 'calDav', typeVersion: 1, id: 'n1' }),
		getTimezone: () => 'Europe/Berlin',
		getCredentials: async () => ({
			serverUrl: SERVER,
			username: 'bob',
			password: 'secret',
			...credentials,
		}),
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		continueOnFail: () => false,
		logger: { debug: vi.fn() },
		helpers: { httpRequestWithAuthentication },
	};
}

const run = async (params: Record<string, unknown>, credentials?: Record<string, unknown>) => {
	const ctx = makeContext(params, credentials);
	const [items] = await new CalDav().execute.call(ctx as any);
	return { items: items.map((x) => x.json as Record<string, any>), ctx };
};

describe('absoluteUrl — origin enforcement', () => {
	it('resolves a path-only href against the server', () => {
		expect(absoluteUrl('/calendars/bob/work/a.ics', SERVER)).toBe(
			'https://dav.example.com/calendars/bob/work/a.ics',
		);
	});

	it('resolves a relative href without a leading slash', () => {
		expect(absoluteUrl('calendars/bob/work/a.ics', SERVER)).toBe(
			'https://dav.example.com/calendars/bob/work/a.ics',
		);
	});

	it('accepts any path on the configured origin', () => {
		// Servers put calendars wherever they like; only the origin is fixed.
		for (const url of [
			'https://dav.example.com/',
			'https://dav.example.com/remote.php/dav/calendars/bob/',
			'https://dav.example.com/calendars/bob/work/20260420-4711%40apple.ics',
		]) {
			expect(absoluteUrl(url, SERVER)).toBe(url);
		}
	});

	it('treats a redundant default port as the same origin', () => {
		expect(absoluteUrl('https://dav.example.com:443/cal/', SERVER)).toBe(
			'https://dav.example.com:443/cal/',
		);
	});

	it('rejects another host, scheme, or port', () => {
		for (const url of [
			'https://evil.example.net/steal',
			'http://dav.example.com/cal/',
			'https://dav.example.com:8443/cal/',
			'http://169.254.169.254/latest/meta-data/',
			'https://dav.example.com.evil.net/cal/',
		]) {
			expect(() => absoluteUrl(url, SERVER), url).toThrow(/configured CalDAV server/);
		}
	});

	it('rejects a non-http scheme instead of treating it as a path', () => {
		expect(() => absoluteUrl('file:///etc/passwd', SERVER)).toThrow(/configured CalDAV server/);
	});

	it('names both origins so the mistake is obvious', () => {
		expect(() => absoluteUrl('https://evil.example.net/steal', SERVER)).toThrow(
			/https:\/\/evil\.example\.net.*https:\/\/dav\.example\.com/s,
		);
	});

	it('keeps a protocol-relative href on the server', () => {
		// "//evil.example.net/x" has no scheme, so it is a path, not a host.
		expect(absoluteUrl('//evil.example.net/x', SERVER)).toBe(
			'https://dav.example.com//evil.example.net/x',
		);
	});
});

describe('resolveEventUrl — explicit Event URL', () => {
	const ctx = () => ({
		getNode: () => ({ name: 'CalDAV', type: 'calDav', typeVersion: 1, id: 't' }),
		logger: { debug: vi.fn() },
		helpers: {
			httpRequestWithAuthentication: vi.fn(async () => {
				throw new Error('should not be called');
			}),
		},
	});

	it('rejects a foreign Event URL before any request is made', async () => {
		const c = ctx();
		await expect(
			resolveEventUrl.call(c as any, WORK, 'e1', 'https://evil.example.net/x.ics', SERVER),
		).rejects.toThrow(/Event URL/);
		expect(c.helpers.httpRequestWithAuthentication).not.toHaveBeenCalled();
	});

	it('still accepts an Event URL elsewhere on the same server', async () => {
		const c = ctx();
		const url = await resolveEventUrl.call(
			c as any,
			WORK,
			'e1',
			'https://dav.example.com/calendars/bob/other/apple.ics',
			SERVER,
		);
		expect(url).toBe('https://dav.example.com/calendars/bob/other/apple.ics');
	});
});

describe('the node refuses to send the credential elsewhere', () => {
	it('rejects a foreign Event URL without contacting anyone', async () => {
		const ctx = makeContext({
			resource: 'event',
			operation: 'get',
			calendar: WORK,
			eventUrl: 'http://169.254.169.254/latest/meta-data/',
		});
		await expect(new CalDav().execute.call(ctx as any)).rejects.toThrow(
			/configured CalDAV server/,
		);
		expect(ctx.requests).toHaveLength(0);
	});

	it('rejects a foreign Calendar URL', async () => {
		// "calendar" is an options parameter, but an expression — or an AI Agent
		// filling the tool schema — can put any string in it.
		await expect(
			run({
				resource: 'event',
				operation: 'getAll',
				calendar: 'https://evil.example.net/cal/',
				returnAll: true,
				timeMin: '2026-04-01T00:00:00Z',
				timeMax: '2026-05-01T00:00:00Z',
			}),
		).rejects.toThrow(/Calendar/);
	});

	it('rejects a foreign Target Calendar on Move', async () => {
		await expect(
			run({
				resource: 'event',
				operation: 'move',
				calendar: WORK,
				uid: 'e1',
				targetCalendar: 'https://evil.example.net/cal/',
			}),
		).rejects.toThrow(/Target Calendar/);
	});

	it('rejects a foreign Default Calendar from the credential', async () => {
		const ctx = makeContext({}, { defaultCalendar: 'https://evil.example.net/cal/' });
		await expect(resolveDefaultCalendar.call(ctx as any, SERVER, 'bob')).rejects.toThrow(
			/Default Calendar/,
		);
	});

	it('rejects a href the server itself points at another origin', async () => {
		const ctx = makeContext({ resource: 'calendar', operation: 'getAll' });
		const original = ctx.helpers.httpRequestWithAuthentication;
		ctx.helpers.httpRequestWithAuthentication = vi.fn(async (cred: string, o: any) => {
			if (o.method === 'PROPFIND' && !String(o.body).includes('current-user-principal') && !String(o.body).includes('calendar-home-set')) {
				return {
					statusCode: 207,
					headers: {},
					body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>https://evil.example.net/cal/</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Evil</d:displayname></d:prop></d:propstat></d:response></d:multistatus>`,
				};
			}
			return original(cred, o);
		}) as any;
		await expect(new CalDav().execute.call(ctx as any)).rejects.toThrow(
			/configured CalDAV server/,
		);
	});
});

describe('legitimate same-origin traffic still flows', () => {
	it('reads an event addressed by a URL on another path of the server', async () => {
		const { items, ctx } = await run({
			resource: 'event',
			operation: 'get',
			calendar: WORK,
			eventUrl: `${OTHER}apple-generated.ics`,
			simplify: true,
		});
		expect(items[0].summary).toBe('Stored');
		expect(ctx.requests).toContainEqual({ method: 'GET', url: `${OTHER}apple-generated.ics` });
	});
});
