import { describe, it, expect } from 'bun:test';

import {
  SmtpTransportError,
  parseRelayUrl,
  parseMessageIdFromReply,
  dotStuffMessage,
  classifyReply,
} from '../../../src/infra/mail/smtpTransport';

describe('smtpTransport pure helpers (MAIL-2)', () => {
  describe('parseRelayUrl', () => {
    it('parses a canonical smtp://host:port URL', () => {
      expect(parseRelayUrl('smtp://127.0.0.1:54325')).toEqual({
        host: '127.0.0.1',
        port: 54325,
      });
    });

    it('defaults the port to 25 when omitted', () => {
      expect(parseRelayUrl('smtp://mail.example.com')).toEqual({
        host: 'mail.example.com',
        port: 25,
      });
    });

    it.each([
      ['', 'empty string'],
      ['   ', 'whitespace only'],
      ['http://localhost:54325', 'http scheme'],
      ['https://localhost:54325', 'https scheme'],
      ['not-a-url', 'unparseable'],
    ])('rejects %p (%s) with PROTOCOL_ERROR', (input) => {
      expect(() => parseRelayUrl(input)).toThrow(SmtpTransportError);
      try {
        parseRelayUrl(input);
      } catch (err) {
        expect(err).toBeInstanceOf(SmtpTransportError);
        expect((err as SmtpTransportError).kind).toBe('PROTOCOL_ERROR');
      }
    });

    it('rejects ports outside the valid 1..65535 range', () => {
      expect(() => parseRelayUrl('smtp://127.0.0.1:0')).toThrow(SmtpTransportError);
      // Port 99999 is parsed by URL as a string but our explicit
      // bounds-check catches it.
      expect(() => parseRelayUrl('smtp://127.0.0.1:99999')).toThrow();
    });
  });

  describe('parseMessageIdFromReply', () => {
    it('extracts a trailing <message-id> token', () => {
      expect(parseMessageIdFromReply('2.0.0 Ok: queued as <01HQXABC123>')).toBe('01HQXABC123');
    });

    it('picks the LAST <...> capture when multiple are present', () => {
      expect(parseMessageIdFromReply('<tag1> some text <message-id-456>')).toBe('message-id-456');
    });

    it('returns null when no <...> capture exists', () => {
      expect(parseMessageIdFromReply('2.0.0 Ok')).toBeNull();
      expect(parseMessageIdFromReply('')).toBeNull();
    });
  });

  describe('dotStuffMessage', () => {
    it('appends the SMTP terminator', () => {
      const out = dotStuffMessage('Subject: hi\r\n\r\nbody');
      expect(out.endsWith('\r\n.\r\n')).toBe(true);
    });

    it('escapes lines that start with a single dot', () => {
      const out = dotStuffMessage('first line\r\n.start-of-period line');
      expect(out).toContain('\r\n..start-of-period line');
      expect(out).not.toContain('\r\n.start-of-period');
    });

    it('escapes a leading dot on the very first line', () => {
      const out = dotStuffMessage('.leading\r\nrest');
      expect(out.startsWith('..leading')).toBe(true);
    });

    it('normalises LF-only line endings to CRLF', () => {
      const out = dotStuffMessage('a\nb\nc');
      expect(out).toBe('a\r\nb\r\nc\r\n.\r\n');
    });

    it('leaves messages without leading-dot lines unchanged except for the terminator', () => {
      const out = dotStuffMessage('Subject: hi\r\n\r\nplain body');
      expect(out).toBe('Subject: hi\r\n\r\nplain body\r\n.\r\n');
    });
  });

  describe('classifyReply', () => {
    it('returns null for 2xx/3xx (success / intermediate)', () => {
      expect(classifyReply({ code: 220, text: 'banner' })).toBeNull();
      expect(classifyReply({ code: 250, text: 'ok' })).toBeNull();
      expect(classifyReply({ code: 354, text: 'go ahead' })).toBeNull();
    });

    it('maps 4xx to REJECTED_4XX', () => {
      const err = classifyReply({ code: 421, text: 'try later' });
      expect(err).toBeInstanceOf(SmtpTransportError);
      expect(err?.kind).toBe('REJECTED_4XX');
      expect(err?.replyCode).toBe(421);
      // Defense-in-depth: no upstream text in the error message.
      expect(err?.message).not.toContain('try later');
    });

    it('maps 5xx to REJECTED_5XX', () => {
      const err = classifyReply({ code: 550, text: 'mailbox unavailable' });
      expect(err?.kind).toBe('REJECTED_5XX');
      expect(err?.replyCode).toBe(550);
      expect(err?.message).not.toContain('mailbox unavailable');
    });

    it('maps codes outside [200, 600) to PROTOCOL_ERROR', () => {
      const err = classifyReply({ code: 700, text: 'invented' });
      expect(err?.kind).toBe('PROTOCOL_ERROR');
    });

    it('SmtpTransportError preserves a stable name and prototype chain', () => {
      const err = new SmtpTransportError('CONNECT_FAILED', null, 'whatever');
      expect(err.name).toBe('SmtpTransportError');
      expect(err).toBeInstanceOf(SmtpTransportError);
      expect(err).toBeInstanceOf(Error);
    });
  });
});
