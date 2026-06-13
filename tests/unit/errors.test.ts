import { describe, expect, it } from 'vitest';
import { ApiError, AuthError, CalmError, ConfigError, errorMessage } from '../../src/errors.js';

// Verifies the error display strings and the instanceof chain.
describe('error types', () => {
  it('formats ConfigError.missingField', () => {
    expect(ConfigError.missingField('tenant').message).toBe('Missing required field: tenant');
  });

  it('formats ConfigError.invalid', () => {
    expect(ConfigError.invalid('region must be valid').message).toBe(
      'Invalid configuration: region must be valid',
    );
  });

  it('formats ApiError.http with status and body', () => {
    const err = ApiError.http(404, 'Resource not found');
    expect(err.message).toContain('404');
    expect(err.message).toContain('Resource not found');
    expect(err.status).toBe(404);
  });

  it('formats ApiError.odata with code and message', () => {
    const err = ApiError.odata(400, 'INVALID_INPUT', "Field 'title' is required");
    expect(err.message).toContain('INVALID_INPUT');
    expect(err.message).toContain("Field 'title' is required");
  });

  it('keeps the instanceof chain across subclasses', () => {
    expect(ConfigError.missingField('x')).toBeInstanceOf(CalmError);
    expect(ApiError.http(500, 'x')).toBeInstanceOf(CalmError);
    expect(new AuthError('no token')).toBeInstanceOf(CalmError);
  });

  it('extracts a message from any thrown value', () => {
    expect(errorMessage(new AuthError('No token available'))).toBe('No token available');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain string')).toBe('plain string');
  });
});
