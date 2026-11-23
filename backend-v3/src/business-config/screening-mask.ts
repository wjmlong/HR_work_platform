import type {Actor} from '../identity/service.js';

// Screening grants are read-only, job-scoped and time-boxed. They never widen
// contact visibility: the structured phone/email fields are masked for anyone
// whose only access comes from such a grant.
export const screeningOnly = (a: Actor) =>
  a.status === 'active' &&
  !!a.screeningScope?.length &&
  !a.roles.some(r => ['admin', 'manager', 'recruiter'].includes(r));

export function maskScreeningContacts<T>(a: Actor, profile: T): T {
  if (!screeningOnly(a) || !profile || typeof profile !== 'object') return profile;
  const out: any = {...profile};
  for (const key of ['phone', 'email']) if (out[key]) out[key] = '***';
  return out as T;
}
