import type { INodeProperties } from 'n8n-workflow';

/**
 * UI for the external ICS feed resource.
 *
 * Read-only by design: a subscription feed is a static file served over HTTPS,
 * so there is nothing to create, update, move or delete. The parameter names
 * mirror the Event resource — the reads answer the same questions and return the
 * same records — but they are declared separately so each one is scoped to this
 * resource and can say "feed" rather than "calendar".
 */
export const icsFeedOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: ['icsFeed'],
			},
		},
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get many events from the subscribed feed within a time window',
				action: 'Get many feed events',
			},
			{
				name: 'Get Next',
				value: 'getNext',
				description: 'Get the next upcoming event(s) in the feed, starting from now',
				action: 'Get the next feed event',
			},
			{
				name: 'Search',
				value: 'search',
				description: 'Search feed events by keyword in title, description, or location',
				action: 'Search feed events',
			},
		],
		default: 'getAll',
	},
];

export const icsFeedFields: INodeProperties[] = [
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'Ferien',
		description:
			'Text to search for. Matched case-insensitively against the event title (SUMMARY), description, location, and UID.',
		displayOptions: {
			show: {
				resource: ['icsFeed'],
				operation: ['search'],
			},
		},
	},
	{
		displayName: 'Lookahead Days',
		name: 'lookaheadDays',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 30,
		description:
			'How far into the future to look for the next event(s). 7 = next week, 30 = next month, 365 = next year. The window starts at the current time.',
		displayOptions: {
			show: {
				resource: ['icsFeed'],
				operation: ['getNext'],
			},
		},
	},
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description:
			'Whether to return a simplified version of the response. When enabled the iCalendar source ("raw") is omitted, which keeps the output readable and — for a recurring series, where every occurrence repeats the same source — much smaller.',
		displayOptions: {
			show: {
				resource: ['icsFeed'],
				operation: ['getAll', 'getNext', 'search'],
			},
		},
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: {
			show: {
				resource: ['icsFeed'],
				operation: ['getAll', 'getNext', 'search'],
			},
		},
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		description: 'Max number of results to return',
		displayOptions: {
			show: {
				resource: ['icsFeed'],
				operation: ['getAll', 'getNext', 'search'],
				returnAll: [false],
			},
		},
	},
	{
		displayName: 'Time Min',
		name: 'timeMin',
		type: 'dateTime',
		required: true,
		default: '={{ $now.startOf("day") }}',
		description:
			'Earliest event start time to return, in ISO 8601 format, e.g. "2026-04-20T00:00:00+02:00". The whole feed is downloaded and filtered here, because a feed serves one static file and cannot answer a query.',
		displayOptions: {
			show: {
				resource: ['icsFeed'],
				operation: ['getAll', 'search'],
			},
		},
	},
	{
		displayName: 'Time Max',
		name: 'timeMax',
		type: 'dateTime',
		required: true,
		default: '={{ $now.plus(7, "days").endOf("day") }}',
		description:
			'Latest event start time to return, in ISO 8601 format, e.g. "2026-04-27T23:59:59+02:00". Must be after Time Min.',
		displayOptions: {
			show: {
				resource: ['icsFeed'],
				operation: ['getAll', 'search'],
			},
		},
	},
];
