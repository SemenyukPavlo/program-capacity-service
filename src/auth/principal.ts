import { Errors } from '../common/errors/domain-error';

export const Scopes = {
  CAPACITY_READ: 'capacity:read',
  RESERVATIONS_WRITE: 'reservations:write',
  RESERVATIONS_RELEASE: 'reservations:release',
} as const;

export type Scope = (typeof Scopes)[keyof typeof Scopes];

export interface Principal {
  /** `sub` claim — the calling client or user. Recorded as actor on every change. */
  subject: string;
  scopes: ReadonlySet<string>;
  /** Programs this principal may access; '*' for all (e.g. internal operations clients). */
  programs: ReadonlySet<string> | '*';
}

/**
 * Programs the caller can't access are reported as NOT FOUND rather than FORBIDDEN, so the
 * API doesn't reveal which program ids exist (IDOR hardening).
 */
export function assertProgramAccess(principal: Principal, programId: string): void {
  if (principal.programs !== '*' && !principal.programs.has(programId)) {
    throw Errors.notFound('PROGRAM_NOT_FOUND', `Program ${programId} not found`);
  }
}

export function accessiblePrograms(principal: Principal): string[] | '*' {
  return principal.programs === '*' ? '*' : [...principal.programs];
}
