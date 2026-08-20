import { describe, expect, it } from 'vitest';
import { assertSafeFeedUrl } from '../nodes/CalDav/IcsFeedFunctions';

/**
 * The guard in front of the external-feed fetch.
 *
 * Everything that reaches it is user-controlled and unauthenticated, so the two
 * things under test are: which addresses are allowed out of the n8n host at all,
 * and that a rejection never quotes the address back — a feed URL is a secret,
 * it usually carries the calendar's access token in its path or query.
 */

const SECRET = 's3cr3t-token';
const HOST = 'feeds.example.com';

/** Every rejection must be curated: no host, no token, no scheme-and-path echo. */
function expectRejected(input: string) {
	let message = '';
	expect(() => {
		try {
			assertSafeFeedUrl(input);
		} catch (error) {
			message = (error as Error).message;
			throw error;
		}
	}).toThrow();
	expect(message).not.toBe('');
	return message;
}

describe('assertSafeFeedUrl — accepted', () => {
	it('keeps a plain HTTPS feed URL, path and query intact', () => {
		const url = `https://${HOST}/calendars/${SECRET}/basic.ics?export=1`;
		expect(assertSafeFeedUrl(url)).toBe(url);
	});

	it('rewrites webcal:// to https://', () => {
		expect(assertSafeFeedUrl(`webcal://${HOST}/basic.ics`)).toBe(`https://${HOST}/basic.ics`);
	});

	it('rewrites webcals:// to https://', () => {
		expect(assertSafeFeedUrl(`webcals://${HOST}/basic.ics`)).toBe(`https://${HOST}/basic.ics`);
	});

	it('accepts the schemes case-insensitively and trims surrounding whitespace', () => {
		expect(assertSafeFeedUrl(`  WEBCAL://${HOST}/basic.ics  `)).toBe(`https://${HOST}/basic.ics`);
		expect(assertSafeFeedUrl(` HTTPS://${HOST}/basic.ics `)).toBe(`https://${HOST}/basic.ics`);
	});

	it('accepts an explicit :443 and normalises it away', () => {
		expect(assertSafeFeedUrl(`https://${HOST}:443/basic.ics`)).toBe(`https://${HOST}/basic.ics`);
	});

	it('accepts a multi-label host with digits and hyphens', () => {
		const url = 'https://p31-caldav.icloud-content.com/published/2/abc123.ics';
		expect(assertSafeFeedUrl(url)).toBe(url);
	});
});

describe('assertSafeFeedUrl — schemes', () => {
	it.each([
		['http', `http://${HOST}/${SECRET}.ics`],
		['ftp', `ftp://${HOST}/${SECRET}.ics`],
		['file', `file:///etc/passwd`],
		['data', 'data:text/calendar,BEGIN:VCALENDAR'],
		['javascript', 'javascript:alert(1)'],
		['scheme-relative', `//${HOST}/${SECRET}.ics`],
		['no scheme', `${HOST}/${SECRET}.ics`],
	])('rejects %s', (_label, input) => {
		expectRejected(input);
	});

	it('rejects an empty or blank Feed URL with a message pointing at the credential', () => {
		expect(() => assertSafeFeedUrl('')).toThrow(/Feed URL/i);
		expect(() => assertSafeFeedUrl('   ')).toThrow(/Feed URL/i);
	});

	it('rejects a URL that does not parse at all', () => {
		expectRejected('https://');
	});
});

describe('assertSafeFeedUrl — hosts', () => {
	it.each([
		['userinfo', `https://user:pass@${HOST}/basic.ics`],
		['userinfo without password', `https://user@${HOST}/basic.ics`],
		['IPv4 literal', 'https://93.184.216.34/basic.ics'],
		['private IPv4 literal', 'https://192.168.1.10/basic.ics'],
		['loopback IPv4 literal', 'https://127.0.0.1/basic.ics'],
		['link-local IPv4 literal', 'https://169.254.169.254/latest/meta-data/'],
		['IPv4 shorthand', 'https://127.1/basic.ics'],
		['hex IPv4', 'https://0x7f000001/basic.ics'],
		['decimal IPv4', 'https://2130706433/basic.ics'],
		['octal IPv4', 'https://0177.0.0.1/basic.ics'],
		['IPv6 loopback', 'https://[::1]/basic.ics'],
		['IPv6 literal', 'https://[2001:db8::1]/basic.ics'],
		['IPv6 mapped IPv4', 'https://[::ffff:169.254.169.254]/basic.ics'],
		['localhost', 'https://localhost/basic.ics'],
		['single-label host', 'https://intranet/basic.ics'],
		['trailing-dot single label', 'https://intranet./basic.ics'],
		['.local mDNS', 'https://nas.local/basic.ics'],
		['.localhost', 'https://feed.localhost/basic.ics'],
		['.internal', 'https://metadata.internal/basic.ics'],
		['.intranet', 'https://wiki.intranet/basic.ics'],
		['.lan', 'https://server.lan/basic.ics'],
		['.home.arpa', 'https://box.home.arpa/basic.ics'],
		['.in-addr.arpa', 'https://1.0.0.127.in-addr.arpa/basic.ics'],
		['underscore label', 'https://feed_host.example.com/basic.ics'],
	])('rejects %s', (_label, input) => {
		expectRejected(input);
	});
});

describe('assertSafeFeedUrl — ports', () => {
	it.each([
		['8443', `https://${HOST}:8443/basic.ics`],
		['80', `https://${HOST}:80/basic.ics`],
		['22', `https://${HOST}:22/basic.ics`],
		['webcal on a custom port', `webcal://${HOST}:8080/basic.ics`],
	])('rejects port %s', (_label, input) => {
		const message = expectRejected(input);
		expect(message).toMatch(/443/);
	});
});

describe('assertSafeFeedUrl — rejections never quote the URL', () => {
	const leaky = [
		`http://${HOST}/${SECRET}.ics`,
		`https://user:${SECRET}@${HOST}/basic.ics`,
		`https://${HOST}:8443/${SECRET}.ics`,
		`https://127.0.0.1/${SECRET}.ics`,
		`https://localhost/${SECRET}.ics`,
		`ftp://${HOST}/${SECRET}.ics`,
		`${HOST}/${SECRET}.ics`,
	];

	it.each(leaky)('does not name the host or token when rejecting %s', (input) => {
		const message = expectRejected(input);
		expect(message).not.toContain(SECRET);
		expect(message).not.toContain(HOST);
		expect(message).not.toContain('127.0.0.1');
		expect(message).not.toContain('localhost');
	});
});
