// The few HTML pages the Worker shows a browser: the consent page (auth.ts)
// and error pages (errors.ts). Everything from a client is escaped.

/** Client-supplied text (names, domains, hosts) is attacker-chosen: always escape it. */
export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A full page with a heading. `body` is trusted HTML; escape anything inside it. */
export function page(status: number, title: string, body: string, headers?: Headers): Response {
  const response = new Response(html(escape(title), `<h1>${escape(title)}</h1>\n${body}`), {
    status,
    headers: headers ?? new Headers(),
  });
  response.headers.set("content-type", "text/html; charset=utf-8");
  lockDown(response.headers);
  return response;
}

/**
 * Every page's security headers: no scripts, images or connections, and no
 * framing. Replaces the OAuth library's weaker policy (framing only).
 */
export function lockDown(headers: Headers): void {
  headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  headers.set("x-frame-options", "DENY");
}

/**
 * The page skeleton. `title` must already be escaped. Inline CSS only (the
 * policy in lockDown allows nothing else): a card that follows the device's
 * light or dark mode, with Allow as the main button.
 */
export function html(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --accent: #1f6feb; --line: #8885; }
  body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 0; padding: 3rem 1rem; }
  main { max-width: 32rem; margin: 0 auto; padding: 1.5rem 1.75rem; border: 1px solid var(--line); border-radius: 12px; }
  h1 { font-size: 1.4rem; line-height: 1.3; margin-top: 0; }
  form { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: 0.55rem 1.4rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
  button[value="approve"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
<main>
${body}
</main>
</html>`;
}
