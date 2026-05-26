export class MissingBearerTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingBearerTokenError';
  }
}

export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new MissingBearerTokenError('Missing Authorization header');
  }
  const match = authorizationHeader.match(/^\s*Bearer\s+(.*)$/i);
  if (!match) {
    throw new MissingBearerTokenError('Authorization header must use Bearer scheme');
  }
  const token = match[1].trim();
  if (!token) {
    throw new MissingBearerTokenError('Authorization Bearer token is empty');
  }
  return token;
}
