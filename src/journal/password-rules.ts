/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The checks and wording shared by every password form: Change password in Settings and the
 * reset page a reset link opens. Kept apart from the forms so the sign-in screen can use them
 * without pulling the Settings sheets into the first download.
 */

/** The journal's shortest accepted password. */
export const PASSWORD_MIN_LENGTH = 8;

/** What is wrong with a new password and its confirmation (here and on the reset page). */
export function newPasswordProblem(next: string, confirm: string): string | undefined {
    if (next.length < PASSWORD_MIN_LENGTH) return "Use at least 8 characters.";
    if (next !== confirm) return "The new passwords don't match.";
    return undefined;
}

/** What is wrong with the form before anything is sent, or undefined when it can go. */
export function passwordProblem(current: string, next: string, confirm: string): string | undefined {
    const problem = newPasswordProblem(next, confirm);
    if (problem) return problem;
    if (next === current) return "Choose a password different from your current one.";
    return undefined;
}

/** "Too many attempts. Try again in N minutes." for a lockout's wait in seconds (at least 1 minute). */
export function lockedOutMessage(retryAfter: number): string {
    const minutes = Math.max(1, Math.ceil(retryAfter / 60));
    return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
