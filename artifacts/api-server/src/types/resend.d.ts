/**
 * Ambient declaration for the OPTIONAL 'resend' dependency.
 *
 * 'resend' is deliberately NOT in package.json: sender.ts dynamic-imports it
 * so an api-server without the package (or without RESEND_API_KEY) still
 * boots and falls back to ConsoleEmailSender. On Replit the package is
 * installed by the Replit Agent when email is enabled.
 *
 * This shorthand declaration exists so `tsc --noEmit` passes in dev
 * environments where the package is absent. sender.ts casts the import to
 * its own minimal ResendModule interface, so no API surface is typed here
 * on purpose — if the real package (with bundled types) is ever added to
 * package.json, delete this file.
 */
declare module "resend";
