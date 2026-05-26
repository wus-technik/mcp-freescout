import { extractBearerToken } from '../auth.js';

describe('extractBearerToken', () => {
  it('returns the token from a valid Bearer header', () => {
    expect(extractBearerToken('Bearer fs_key_abc123')).toBe('fs_key_abc123');
  });

  it('trims whitespace around the token', () => {
    expect(extractBearerToken('Bearer   fs_key_abc123   ')).toBe('fs_key_abc123');
  });

  it('throws when the header is missing', () => {
    expect(() => extractBearerToken(undefined)).toThrow(/Authorization/i);
  });

  it('throws when the scheme is not Bearer', () => {
    expect(() => extractBearerToken('Basic dXNlcjpwYXNz')).toThrow(/Bearer/i);
  });

  it('throws when the token is empty', () => {
    expect(() => extractBearerToken('Bearer ')).toThrow(/empty/i);
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer fs_key_abc123')).toBe('fs_key_abc123');
  });
});
