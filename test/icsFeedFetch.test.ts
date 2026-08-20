import { describe, expect, it, vi } from 'vitest';
import { fetchIcsFeed, MAX_FEED_BYTES } from '../nodes/CalDav/IcsFeedFunctions';

/**
 * The external-feed transport.
 *
 * A subscribed feed is fetched over a path that shares nothing with the CalDAV
 * one: no credential, no cookies, no redirect handling delegated to the HTTP
 * client. These tests pin that separation down, along with the response limits
 * and the shape of every error message the user can see.
 */

const HOST = 'feeds.example.com';
const SECRET = 's3cr3t-token';
const FEED = `https://${HOST}/calendars/${SECRET}/basic.ics`;

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//x//EN', 'END:VCALENDAR'].join('\r\n');

type Response = { statusCode: number; headers?: Record<string, string>; body?: string };

function makeCtx(handler: (url: string, options: any) => Response | Promise<Response>) {
	const calls: any[] = [];
	const httpRequest = vi.fn(async (options: any) => {
		calls.push(options);
		const response = await handler(String(options.url), options);
		return { statusCode: response.statusCode, headers: response.headers ?? {}, body: response.body ?? '' };
	});
	const httpRequestWithAuthentication = vi.fn(async () => {
		throw new Error('an external feed must never go through an authenticated request');
	});
	return {
		calls,
		httpRequest,
		httpRequestWithAuthentication,
		getNode: () => ({ name: 'CalDAV', type: 'calDav', typeVersion: 1, id: 'n1' }),
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		helpers: { httpRequest, httpRequestWithAuthentication },
	};
}

const ok = (body = ICS, headers: Record<string, string> = {}): Response => ({
	statusCode: 200,
	headers: { 'content-type': 'text/calendar; charset=utf-8', ...headers },
	body,
});

/** Fetch and return the error message, asserting it was rejected. */
async function failure(ctx: any, url = FEED): Promise<string> {
	try {
		await fetchIcsFeed.call(ctx as any, url);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error('expected the feed fetch to be rejected');
}

/** No error text may name the feed, its host, its token, or the server's body. */
function expectCurated(message: string) {
	expect(message).not.toContain(HOST);
	expect(message).not.toContain(SECRET);
	expect(message).not.toContain(FEED);
	expect(message).not.toContain('https://');
}

describe('fetchIcsFeed — the request itself', () => {
	it('returns the feed body', async () => {
		const ctx = makeCtx(() => ok());
		expect(await fetchIcsFeed.call(ctx as any, FEED)).toBe(ICS);
	});

	it('issues an unauthenticated GET that carries no credential or cookie', async () => {
		const ctx = makeCtx(() => ok());
		await fetchIcsFeed.call(ctx as any, FEED);

		expect(ctx.httpRequestWithAuthentication).not.toHaveBeenCalled();
		expect(ctx.httpRequest).toHaveBeenCalledTimes(1);
		const options = ctx.calls[0];
		expect(options.method).toBe('GET');
		expect(options.url).toBe(FEED);
		expect(options.auth).toBeUndefined();
		expect(options.body).toBeUndefined();
		const headerNames = Object.keys(options.headers ?? {}).map((h) => h.toLowerCase());
		expect(headerNames).not.toContain('authorization');
		expect(headerNames).not.toContain('cookie');
	});

	it('never lets the HTTP client follow redirects on its own', async () => {
		const ctx = makeCtx(() => ok());
		await fetchIcsFeed.call(ctx as any, FEED);
		expect(ctx.calls[0].disableFollowRedirect).toBe(true);
		expect(ctx.calls[0].returnFullResponse).toBe(true);
		expect(ctx.calls[0].ignoreHttpStatusErrors).toBe(true);
		expect(ctx.calls[0].json).toBe(false);
	});

	it('validates the URL before making any request', async () => {
		const ctx = makeCtx(() => ok());
		const message = await failure(ctx, `http://${HOST}/${SECRET}.ics`);
		expect(ctx.httpRequest).not.toHaveBeenCalled();
		expectCurated(message);
	});

	it('accepts a webcal:// feed and requests it over https', async () => {
		const ctx = makeCtx(() => ok());
		await fetchIcsFeed.call(ctx as any, `webcal://${HOST}/basic.ics`);
		expect(ctx.calls[0].url).toBe(`https://${HOST}/basic.ics`);
	});
});

describe('fetchIcsFeed — memoisation', () => {
	it('fetches once per execution however many items are processed', async () => {
		const ctx = makeCtx(() => ok());
		const bodies = await Promise.all([
			fetchIcsFeed.call(ctx as any, FEED),
			fetchIcsFeed.call(ctx as any, FEED),
			fetchIcsFeed.call(ctx as any, FEED),
		]);
		expect(bodies).toEqual([ICS, ICS, ICS]);
		expect(ctx.httpRequest).toHaveBeenCalledTimes(1);
	});

	it('does not share the memo between executions', async () => {
		const first = makeCtx(() => ok());
		const second = makeCtx(() => ok());
		await fetchIcsFeed.call(first as any, FEED);
		await fetchIcsFeed.call(second as any, FEED);
		expect(first.httpRequest).toHaveBeenCalledTimes(1);
		expect(second.httpRequest).toHaveBeenCalledTimes(1);
	});

	it('does not memoise a failure', async () => {
		let attempt = 0;
		const ctx = makeCtx(() => (++attempt === 1 ? { statusCode: 503 } : ok()));
		await failure(ctx);
		expect(await fetchIcsFeed.call(ctx as any, FEED)).toBe(ICS);
		expect(ctx.httpRequest).toHaveBeenCalledTimes(2);
	});
});

describe('fetchIcsFeed — redirects', () => {
	it('follows a same-origin redirect', async () => {
		const ctx = makeCtx((url) =>
			url === FEED
				? { statusCode: 302, headers: { location: `https://${HOST}/moved.ics` } }
				: ok(),
		);
		expect(await fetchIcsFeed.call(ctx as any, FEED)).toBe(ICS);
		expect(ctx.calls.map((c) => c.url)).toEqual([FEED, `https://${HOST}/moved.ics`]);
	});

	it('resolves a relative Location against the current URL', async () => {
		const ctx = makeCtx((url) =>
			url === FEED ? { statusCode: 301, headers: { location: '/other.ics' } } : ok(),
		);
		await fetchIcsFeed.call(ctx as any, FEED);
		expect(ctx.calls[1].url).toBe(`https://${HOST}/other.ics`);
	});

	it('re-validates every hop, so a redirect to a private address is refused', async () => {
		const ctx = makeCtx(() => ({ statusCode: 302, headers: { location: 'https://169.254.169.254/' } }));
		const message = await failure(ctx);
		expect(message).not.toContain('169.254.169.254');
		expectCurated(message);
		expect(ctx.httpRequest).toHaveBeenCalledTimes(1);
	});

	it('refuses a redirect that leaves the origin', async () => {
		const ctx = makeCtx(() => ({
			statusCode: 302,
			headers: { location: 'https://attacker.example.net/steal.ics' },
		}));
		const message = await failure(ctx);
		expect(message).toMatch(/redirect/i);
		expect(message).not.toContain('attacker.example.net');
		expectCurated(message);
	});

	it('refuses a redirect that downgrades to http', async () => {
		const ctx = makeCtx(() => ({ statusCode: 301, headers: { location: `http://${HOST}/basic.ics` } }));
		expectCurated(await failure(ctx));
	});

	it('refuses a redirect to a different port on the same host', async () => {
		const ctx = makeCtx(() => ({ statusCode: 307, headers: { location: `https://${HOST}:8443/basic.ics` } }));
		expectCurated(await failure(ctx));
	});

	it('follows at most three redirects', async () => {
		let hop = 0;
		const ctx = makeCtx(() => ({
			statusCode: 302,
			headers: { location: `https://${HOST}/hop-${++hop}.ics` },
		}));
		const message = await failure(ctx);
		expect(message).toMatch(/redirect/i);
		// The original request plus the three hops it is allowed to follow.
		expect(ctx.httpRequest).toHaveBeenCalledTimes(4);
		expectCurated(message);
	});

	it('accepts a chain that ends within the limit', async () => {
		const ctx = makeCtx((url) => {
			const hop = /hop-(\d)/.exec(url);
			const n = hop ? Number(hop[1]) : 0;
			return n === 3 ? ok() : { statusCode: 302, headers: { location: `https://${HOST}/hop-${n + 1}.ics` } };
		});
		expect(await fetchIcsFeed.call(ctx as any, FEED)).toBe(ICS);
		expect(ctx.httpRequest).toHaveBeenCalledTimes(4);
	});

	it('reports a redirect with no destination', async () => {
		const ctx = makeCtx(() => ({ statusCode: 302, headers: {} }));
		expectCurated(await failure(ctx));
	});
});

describe('fetchIcsFeed — responses that are not a feed', () => {
	it('explains a 401 without suggesting the node can authenticate', async () => {
		const ctx = makeCtx(() => ({ statusCode: 401, headers: {}, body: `token ${SECRET} rejected` }));
		const message = await failure(ctx);
		expect(message).toMatch(/401/);
		expectCurated(message);
	});

	it('explains a 404', async () => {
		const ctx = makeCtx(() => ({ statusCode: 404, headers: {}, body: `no feed at /${SECRET}` }));
		const message = await failure(ctx);
		expect(message).toMatch(/404/);
		expectCurated(message);
	});

	it('reports a server error without echoing the body', async () => {
		const ctx = makeCtx(() => ({
			statusCode: 500,
			headers: {},
			body: `<html>stack trace mentioning ${SECRET} and ${HOST}</html>`,
		}));
		const message = await failure(ctx);
		expect(message).toMatch(/500/);
		expectCurated(message);
	});

	it('rejects an HTML page that is not an iCalendar document', async () => {
		const ctx = makeCtx(() =>
			ok(`<html><body>Sign in to ${HOST} with ${SECRET}</body></html>`, {
				'content-type': 'text/html',
			}),
		);
		const message = await failure(ctx);
		expect(message).toMatch(/BEGIN:VCALENDAR/);
		expectCurated(message);
	});

	it('rejects an empty body', async () => {
		const ctx = makeCtx(() => ok(''));
		expectCurated(await failure(ctx));
	});

	it('rejects a body over the size limit', async () => {
		const huge = `BEGIN:VCALENDAR\r\n${'X'.repeat(MAX_FEED_BYTES)}`;
		const ctx = makeCtx(() => ok(huge));
		const message = await failure(ctx);
		expect(message).toMatch(/5 MB/);
		expectCurated(message);
	});

	it('rejects on an oversized Content-Length before reading the body', async () => {
		const ctx = makeCtx(() => ok(ICS, { 'content-length': String(MAX_FEED_BYTES + 1) }));
		const message = await failure(ctx);
		expect(message).toMatch(/5 MB/);
		expectCurated(message);
	});

	it('accepts a body that carries a UTF-8 BOM before BEGIN:VCALENDAR', async () => {
		const ctx = makeCtx(() => ok(`\ufeff${ICS}`));
		expect(await fetchIcsFeed.call(ctx as any, FEED)).toContain('BEGIN:VCALENDAR');
	});
});

describe('fetchIcsFeed — transport failures', () => {
	it.each([
		['ENOTFOUND', `getaddrinfo ENOTFOUND ${HOST}`],
		['ECONNREFUSED', `connect ECONNREFUSED 203.0.113.5:443`],
		['ETIMEDOUT', `connect ETIMEDOUT ${HOST}`],
		['CERT_HAS_EXPIRED', `certificate has expired for ${HOST}`],
	])('turns a %s into a curated message', async (code, raw) => {
		const ctx = makeCtx(() => {
			const error: any = new Error(raw);
			error.code = code;
			throw error;
		});
		const message = await failure(ctx);
		expect(message).not.toContain(raw);
		expect(message).not.toContain('203.0.113.5');
		expectCurated(message);
	});

	it('does not leak an error message that has no code at all', async () => {
		const ctx = makeCtx(() => {
			throw new Error(`request to ${FEED} failed`);
		});
		expectCurated(await failure(ctx));
	});
});
