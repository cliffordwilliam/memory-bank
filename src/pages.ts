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
  if (!response.headers.has("content-security-policy")) {
    response.headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    response.headers.set("x-frame-options", "DENY");
  }
  return response;
}

/** The page skeleton. `title` must already be escaped. */
export function html(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  button { font: inherit; padding: 0.5rem 1.25rem; margin-right: 0.5rem; cursor: pointer; }
</style>
${body}
</html>`;
}
