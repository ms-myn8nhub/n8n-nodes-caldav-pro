import { describe, expect, it } from 'vitest';
import { buildICalEvent, parseICalEvent, patchICalEvent } from '../nodes/CalDav/GenericFunctions';
import { line, lines, unfold, withTZ } from './helpers';

/** An event as a real calendar app would store it: richer than this node models. */
const existing = [
	'BEGIN:VCALENDAR',
	'VERSION:2.0',
	'PRODID:-//Apple Inc.//macOS 14//EN',
	'CALSCALE:GREGORIAN',
	'BEGIN:VEVENT',
	'UID:existing-uid',
	'DTSTAMP:20260101T000000Z',
	'DTSTART;TZID=Europe/Berlin:20260420T140000',
	'DTEND;TZID=Europe/Berlin:20260420T150000',
	'SUMMARY:Original title',
	'DESCRIPTION:Agenda from the organiser',
	'LOCATION:Room 3',
	'CATEGORIES:work,important',
	'STATUS:CONFIRMED',
	'TRANSP:OPAQUE',
	'ORGANIZER;CN=Boss:mailto:boss@example.com',
	'ATTENDEE;CN=Alice:mailto:alice@example.com',
	'RRULE:FREQ=WEEKLY;BYDAY=MO',
	'SEQUENCE:3',
	'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
	'BEGIN:VALARM',
	'ACTION:DISPLAY',
	'TRIGGER:-PT15M',
	'DESCRIPTION:Reminder',
	'END:VALARM',
	'END:VEVENT',
	'END:VCALENDAR',
].join('\r\n');

describe('patchICalEvent — preservation', () => {
	it('keeps every property the patch does not mention', () => {
		// This is the regression this function exists for: the previous Update
		// rebuilt the event from the node's fields alone and dropped the rest.
		const out = patchICalEvent(existing, { summary: 'New title' });
		expect(line(out, 'DESCRIPTION')).toBe('DESCRIPTION:Agenda from the organiser');
		expect(line(out, 'LOCATION')).toBe('LOCATION:Room 3');
		expect(line(out, 'CATEGORIES')).toBe('CATEGORIES:work,important');
		expect(line(out, 'STATUS')).toBe('STATUS:CONFIRMED');
		expect(line(out, 'TRANSP')).toBe('TRANSP:OPAQUE');
		expect(line(out, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO');
		expect(line(out, 'ORGANIZER')).toContain('mailto:boss@example.com');
		expect(line(out, 'ATTENDEE')).toContain('mailto:alice@example.com');
		expect(line(out, 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR')).toBeDefined();
		expect(unfold(out)).toContain('TRIGGER:-PT15M');
	});

	it('preserves the UID', () => {
		const out = patchICalEvent(existing, { summary: 'New title' });
		expect(line(out, 'UID')).toBe('UID:existing-uid');
	});

	it('applies only the fields it was given', () => {
		const out = patchICalEvent(existing, { summary: 'New title', location: 'Room 9' });
		expect(line(out, 'SUMMARY')).toBe('SUMMARY:New title');
		expect(line(out, 'LOCATION')).toBe('LOCATION:Room 9');
		expect(line(out, 'DESCRIPTION')).toBe('DESCRIPTION:Agenda from the organiser');
	});

	it('replaces attendees wholesale once any are supplied', () => {
		const out = patchICalEvent(existing, {
			attendees: [{ email: 'bob@example.com' }, { email: 'carol@example.com' }],
		});
		const all = lines(out, 'ATTENDEE');
		expect(all).toHaveLength(2);
		expect(all.join(' ')).not.toContain('alice@example.com');
	});

	it('replaces reminders wholesale once any are supplied', () => {
		const out = patchICalEvent(existing, { reminders: [{ minutesBefore: 60 }] });
		const flat = unfold(out);
		expect(flat.filter((l) => l === 'BEGIN:VALARM')).toHaveLength(1);
		expect(flat).toContain('TRIGGER:-PT1H');
	});

	it('writes RFC-compliant EMAIL alarms on patch when attendees already exist', () => {
		const out = patchICalEvent(existing, { reminders: [{ minutesBefore: 30, action: 'EMAIL' }] });
		const flat = unfold(out);
		expect(flat).toContain('ACTION:EMAIL');
		expect(flat).toContain('SUMMARY:Original title');
		expect(flat.filter((l) => l.includes('ATTENDEE') && l.includes('mailto:alice@example.com')).length).toBeGreaterThanOrEqual(2);
	});

	it('falls back to DISPLAY on patch when EMAIL reminders have no attendees', () => {
		const noAttendees = existing.replace('ATTENDEE;CN=Alice:mailto:alice@example.com\r\n', '');
		const out = patchICalEvent(noAttendees, { reminders: [{ minutesBefore: 30, action: 'EMAIL' }] });
		const flat = unfold(out);
		expect(flat).toContain('ACTION:DISPLAY');
		expect(flat).not.toContain('ACTION:EMAIL');
	});
});

describe('patchICalEvent — clearing', () => {
	it('removes a text property when given an empty string', () => {
		const out = patchICalEvent(existing, { description: '', location: '' });
		expect(line(out, 'DESCRIPTION')).toBeUndefined();
		expect(line(out, 'LOCATION')).toBeUndefined();
	});

	it('removes the recurrence when given an empty rrule', () => {
		const out = patchICalEvent(existing, { rrule: '' });
		expect(line(out, 'RRULE')).toBeUndefined();
	});

	it('removes all alarms when given an empty reminder list', () => {
		const out = patchICalEvent(existing, { reminders: [] });
		expect(unfold(out)).not.toContain('BEGIN:VALARM');
	});
});

describe('patchICalEvent — date handling', () => {
	it('inherits the stored TZID when the patch omits a timezone', () => {
		const out = withTZ('UTC', () =>
			patchICalEvent(existing, {
				start: '2026-04-20T16:00:00+02:00',
				end: '2026-04-20T17:00:00+02:00',
			}),
		);
		expect(line(out, 'DTSTART')).toBe('DTSTART;TZID=Europe/Berlin:20260420T160000');
	});

	it('honours an explicit timezone over the stored one', () => {
		const out = withTZ('UTC', () =>
			patchICalEvent(existing, {
				start: '2026-04-20T16:00:00+02:00',
				end: '2026-04-20T17:00:00+02:00',
				timezone: 'Asia/Tokyo',
			}),
		);
		expect(line(out, 'DTSTART')).toBe('DTSTART;TZID=Asia/Tokyo:20260420T230000');
	});

	it('keeps an all-day event all-day when the patch omits the flag', () => {
		const allDaySource = buildICalEvent({
			uid: 'ad',
			summary: 'Holiday',
			start: '2026-04-20T00:00:00Z',
			end: '2026-04-21T00:00:00Z',
			allDay: true,
		});
		const out = patchICalEvent(allDaySource, {
			start: '2026-05-01T00:00:00Z',
			end: '2026-05-02T00:00:00Z',
		});
		expect(line(out, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20260501');
	});

	it('rejects a half-specified range instead of guessing', () => {
		expect(() => patchICalEvent(existing, { start: '2026-04-20T16:00:00Z' })).toThrow(
			/Start and End must be updated together/,
		);
	});

	it('rejects timed patches whose end is not after the start', () => {
		expect(() =>
			patchICalEvent(existing, { start: '2026-04-20T16:00:00+02:00', end: '2026-04-20T16:00:00+02:00' }),
		).toThrow(/End must be after Start/);
	});

	it('keeps same-day all-day patches valid by writing an exclusive next-day DTEND', () => {
		const allDaySource = buildICalEvent({
			uid: 'ad',
			summary: 'Holiday',
			start: '2026-04-20T00:00:00Z',
			end: '2026-04-21T00:00:00Z',
			allDay: true,
		});
		const out = patchICalEvent(allDaySource, {
			start: '2026-05-01T00:00:00Z',
			end: '2026-05-01T00:00:00Z',
			allDay: true,
		});
		expect(line(out, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20260501');
		expect(line(out, 'DTEND')).toBe('DTEND;VALUE=DATE:20260502');
	});
});

describe('patchICalEvent — bookkeeping', () => {
	it('increments SEQUENCE so clients see the change', () => {
		expect(line(patchICalEvent(existing, { summary: 'a' }), 'SEQUENCE')).toBe('SEQUENCE:4');
	});

	it('starts SEQUENCE at 1 when the source has none', () => {
		const noSeq = existing.replace('SEQUENCE:3\r\n', '');
		expect(line(patchICalEvent(noSeq, { summary: 'a' }), 'SEQUENCE')).toBe('SEQUENCE:1');
	});

	it('refreshes DTSTAMP and sets LAST-MODIFIED', () => {
		const out = patchICalEvent(existing, { summary: 'a' });
		expect(line(out, 'DTSTAMP')).not.toBe('DTSTAMP:20260101T000000Z');
		expect(line(out, 'DTSTAMP')).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/);
		expect(line(out, 'LAST-MODIFIED')).toMatch(/^LAST-MODIFIED:\d{8}T\d{6}Z$/);
	});

	it('refuses to overwrite a resource that holds no VEVENT', () => {
		const vtodo = existing.replace(/VEVENT/g, 'VTODO');
		expect(() => patchICalEvent(vtodo, { summary: 'a' })).toThrow(/no VEVENT/);
	});
});

describe('patchICalEvent — series master', () => {
	/**
	 * A series whose moved occurrence is serialised *before* its master. Nothing
	 * in RFC 5545 fixes the order of the VEVENTs inside one object, and a server
	 * hands back whatever the client that wrote them produced.
	 */
	const overrideFirst = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//x//EN',
		'BEGIN:VEVENT',
		'UID:s1',
		'DTSTAMP:20260101T000000Z',
		'RECURRENCE-ID:20260413T100000Z',
		'DTSTART:20260413T160000Z',
		'DTEND:20260413T170000Z',
		'SUMMARY:Moved occurrence',
		'SEQUENCE:5',
		'END:VEVENT',
		'BEGIN:VEVENT',
		'UID:s1',
		'DTSTAMP:20260101T000000Z',
		'DTSTART:20260406T100000Z',
		'DTEND:20260406T110000Z',
		'SUMMARY:Series master',
		'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
		'SEQUENCE:2',
		'END:VEVENT',
		'END:VCALENDAR',
	].join('\r\n');

	/** The body of each VEVENT, in the order they appear. */
	const blocks = (ics: string) =>
		ics
			.split('BEGIN:VEVENT')
			.slice(1)
			.map((b) => b.slice(0, b.indexOf('END:VEVENT')));

	it('changes the master, not whichever VEVENT happens to come first', () => {
		// "Entire Series" used to rename only the moved occurrence, and report
		// success while the series itself was untouched.
		const [override, master] = blocks(patchICalEvent(overrideFirst, { summary: 'Renamed series' }));
		expect(master).toContain('SUMMARY:Renamed series');
		expect(master).toContain('RRULE:FREQ=WEEKLY');
		expect(override).toContain('SUMMARY:Moved occurrence');
	});

	it('bumps the revision on the master', () => {
		const [override, master] = blocks(patchICalEvent(overrideFirst, { summary: 'Renamed series' }));
		expect(master).toContain('SEQUENCE:3');
		expect(override).toContain('SEQUENCE:5');
	});

	it('still works when the master comes first', () => {
		const masterFirst = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//x//EN',
			'BEGIN:VEVENT',
			'UID:s1',
			'DTSTAMP:20260101T000000Z',
			'DTSTART:20260406T100000Z',
			'DTEND:20260406T110000Z',
			'SUMMARY:Series master',
			'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:s1',
			'DTSTAMP:20260101T000000Z',
			'RECURRENCE-ID:20260413T100000Z',
			'DTSTART:20260413T160000Z',
			'DTEND:20260413T170000Z',
			'SUMMARY:Moved occurrence',
			'END:VEVENT',
			'END:VCALENDAR',
		].join('\r\n');
		const [master, override] = blocks(patchICalEvent(masterFirst, { summary: 'Renamed series' }));
		expect(master).toContain('SUMMARY:Renamed series');
		expect(override).toContain('SUMMARY:Moved occurrence');
	});
});

describe('round trip', () => {
	it('parses back what it wrote', () => {
		const ics = withTZ('UTC', () =>
			buildICalEvent({
				uid: 'rt',
				summary: 'Standup, daily',
				start: '2026-04-20T09:00:00+02:00',
				end: '2026-04-20T09:15:00+02:00',
				timezone: 'Europe/Berlin',
				description: 'Line one\nline two',
				location: 'Room 1; upstairs',
				rrule: 'FREQ=DAILY;COUNT=5',
				attendees: [{ email: 'alice@example.com', name: 'Alice' }],
				reminders: [{ minutesBefore: 10 }],
			}),
		);
		const ev = parseICalEvent(ics, 'https://example.com/cal/rt.ics', 'etag-1')!;
		expect(ev).not.toBeNull();
		expect(ev.uid).toBe('rt');
		expect(ev.summary).toBe('Standup, daily');
		expect(ev.description).toBe('Line one\nline two');
		expect(ev.location).toBe('Room 1; upstairs');
		expect(ev.rrule).toContain('FREQ=DAILY');
		expect(ev.attendees).toEqual(['alice@example.com']);
		expect(ev.reminders).toEqual([{ minutesBefore: 10, action: 'DISPLAY' }]);
		expect(ev.allDay).toBe(false);
		expect(ev.etag).toBe('etag-1');
	});

	it('survives a patch without losing parseability', () => {
		const out = patchICalEvent(existing, { summary: 'Patched', location: '' });
		const ev = parseICalEvent(out, 'https://example.com/cal/existing-uid.ics')!;
		expect(ev.summary).toBe('Patched');
		expect(ev.location).toBeUndefined();
		expect(ev.description).toBe('Agenda from the organiser');
	});
});
