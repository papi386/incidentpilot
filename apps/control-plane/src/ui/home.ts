import type { AppUser, IntegrationInstallation } from "@incidentpilot/domain";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderHome(
  user: AppUser | null,
  installations: IntegrationInstallation[],
  message?: string
): string {
  const notice = message
    ? `<div class="notice">${escapeHtml(message)}</div>`
    : "";

  const account = user
    ? `
      <section class="card">
        <div class="profile">
          ${user.avatarUrl ? `<img src="${escapeHtml(user.avatarUrl)}" alt="" width="48" height="48">` : ""}
          <div>
            <strong>${escapeHtml(user.displayName ?? user.username)}</strong>
            <div class="muted">@${escapeHtml(user.username)}</div>
          </div>
        </div>
        <div class="actions">
          <a class="button" href="/github/install">Install / update GitHub App</a>
          <a class="button secondary-link" href="/github/refresh">Refresh installations</a>
          <form method="post" action="/auth/logout"><button class="secondary" type="submit">Sign out</button></form>
        </div>
      </section>
      <section class="card">
        <h2>Connected installations</h2>
        ${installations.length === 0
          ? `<p>No repository installation is connected yet.</p>`
          : `<ul>${installations.map((installation) => `
              <li>
                <strong>${escapeHtml(installation.accountLogin)}</strong>
                <span class="muted">${escapeHtml(installation.accountType)} · ${escapeHtml(installation.repositorySelection)} repositories</span>
              </li>`).join("")}</ul>`}
      </section>`
    : `
      <section class="hero card">
        <h1>IncidentPilot</h1>
        <p>Reliability-first autonomous software incident investigation.</p>
        <a class="button" href="/auth/github/login">Continue with GitHub</a>
      </section>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IncidentPilot</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 820px; margin: 0 auto; padding: 48px 20px; line-height: 1.5; }
    .card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 16px; padding: 24px; margin-bottom: 20px; }
    .hero { padding: 44px 32px; }
    h1 { font-size: 42px; margin: 0 0 8px; }
    h2 { margin-top: 0; }
    .button, button { display: inline-block; border: 0; border-radius: 10px; padding: 11px 16px; font: inherit; cursor: pointer; text-decoration: none; background: CanvasText; color: Canvas; }
    button.secondary, .secondary-link { background: transparent; color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); }
    .profile, .actions { display: flex; align-items: center; gap: 14px; }
    .actions { margin-top: 20px; flex-wrap: wrap; }
    .actions form { margin: 0; }
    img { border-radius: 50%; }
    .muted { opacity: .68; font-size: 14px; }
    .notice { padding: 12px 16px; margin-bottom: 20px; border-radius: 10px; background: color-mix(in srgb, CanvasText 8%, transparent); }
    ul { padding-left: 20px; }
    li { margin: 10px 0; }
    li .muted { display: block; }
  </style>
</head>
<body>
  ${notice}
  ${account}
</body>
</html>`;
}
