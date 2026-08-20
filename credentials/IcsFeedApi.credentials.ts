import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * A subscription link to a read-only iCalendar feed.
 *
 * Deliberately not a CalDAV credential: there is no server URL, no username and
 * no password, because the feed is fetched unauthenticated. It is a separate
 * credential type so that a workflow reading a public holiday calendar cannot be
 * handed the CalDAV account's password, and so that revoking one has no effect
 * on the other.
 *
 * There is no `authenticate()` hook and no credential test. n8n's test request
 * is issued by the core HTTP client straight from this declaration, which would
 * put a request to a user-supplied address on a path that skips this node's URL
 * guard entirely — the address is validated where the feed is actually read.
 */
export class IcsFeedApi implements ICredentialType {
	name = 'icsFeedApi';

	displayName = 'ICS Feed API';

	documentationUrl = 'https://github.com/daisytwo/n8n-nodes-caldav-pro';

	properties: INodeProperties[] = [
		{
			displayName: 'Feed URL',
			name: 'feedUrl',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'https://example.com/calendars/public/holidays.ics',
			description:
				'The subscription link of a public iCalendar feed. Accepts https://, webcal:// and webcals:// — a webcal address is read over HTTPS. Stored as a secret because these links usually carry an access token in the path or query, which grants read access to the whole calendar. Must be a public host on port 443; IP addresses, private network names and other ports are refused.',
			required: true,
		},
		{
			displayName: 'Feed Name',
			name: 'feedName',
			type: 'string',
			default: '',
			placeholder: 'School Holidays',
			description:
				'Optional label reported as "feedName" on every event this feed returns, so events from several feeds can be told apart downstream. The feed URL itself is never written to the output.',
		},
	];
}
