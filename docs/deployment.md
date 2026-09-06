# Publishing the report archive

Every run writes its report into `publish/`, alongside a regenerated
`index.html` listing every report kept. Serving that directory behind a
password gives you a browsable archive instead of a stream of emails.

Nothing in this document contains a real host, path, or password. Fill those in
from your own `.env` and server configuration — **this repository is public.**

## Shape of it

```
publish/
  index.html                     archive listing, regenerated every run
  login.html                     unlock page, served without the cookie
  reports/
    report-2026-09-06T09-55.html one file per run
    report-2026-09-06T06-00.html
```

Two ways to get that onto the web server:

**A. The scanner runs on the web server.** Simplest. Point `publish.localDir`
at the directory nginx serves and leave `publish.upload.enabled` false — the
files are written straight into place, nothing is transferred.

**B. The scanner runs elsewhere** (a home PC, say) and uploads. Fill in
`VPS_HOST`, `VPS_USER`, `VPS_PATH` and `VPS_SSH_KEY` in `.env`, then set
`publish.upload.enabled` to true. Each run sends only the new report and the
refreshed index — a couple of hundred KB, not the whole archive.

## Access control

**The check must happen in the web server, not in the page.**

A password checked in client-side JavaScript is decoration: the browser has
already downloaded the page and everything in it before the check runs, and
anyone can skip straight to `reports/report-….html`. The same applies to any
"hide the content until the right password is typed" scheme.

### Why not Basic Auth

Basic Auth is the obvious choice, but its prompt always asks for a username —
that field is part of the protocol and cannot be removed. For a single-user
archive where one password is wanted, the cookie gate below gives the same
server-side enforcement without the extra field, and needs no `htpasswd` file
(so no `apache2-utils` dependency).

Basic Auth remains a perfectly good option if you would rather have it, and
comes with browser password-manager support. The two are equivalent in strength:
both are a shared secret sent over TLS on every request.

### Cookie gate

`login.html` is generated with each run. It collects a password, hashes it, and
stores the digest in a cookie scoped to that directory; it performs no validation
and contains no secret, so it is safe to publish. nginx compares the cookie and
returns a redirect instead of content when it does not match — an unauthenticated
visitor never receives a byte of the archive.

The cookie carries `SHA-256(password)` as hex, not the password. A cookie value
cannot legally hold whitespace or `, ; " \` (RFC 6265), so sending the password
raw either corrupts it or restricts which passwords may be used; hex has neither
problem, and is equally safe to paste into an nginx config or a shell command. It
also means the server never stores the plaintext.

Get the digest with:

```bash
printf %s 'your-password' | sha256sum
```

At `http` level, outside any `server` block:

```nginx
map $cookie_hh $hh_ok {
    default   0;
    "<the 64-character digest>"  1;
}
```

Inside the HTTPS `server` block:

```nginx
location = /your-path { return 301 /your-path/; }

# The unlock page must stay reachable without the cookie, or there is no way in.
location = /your-path/login {
    root /var/www;
    try_files /your-directory/login.html =404;
    add_header Cache-Control "no-store" always;
}

location ^~ /your-path/ {
    if ($hh_ok = 0) {
        return 302 /your-path/login;
    }

    root /var/www;
    index index.html;
    try_files $uri $uri.html $uri/ =404;
    autoindex off;

    # Regenerated three times a day; do not let a proxy or the browser serve a
    # stale copy.
    add_header Cache-Control "no-store, must-revalidate" always;
    add_header X-Robots-Tag  "noindex, nofollow" always;
}
```

Four things to get right:

- Use `^~`, not a bare prefix. A plain `location /your-path/` is outranked by any
  regex location in the same server block — a common one is
  `location ~* \.(css|js)$` — so assets under the gated path would be served from
  the main site root, **without the cookie check**.
- Name the location for the URL prefix and use `root`, not `alias`. Where the URL
  prefix matches the directory name, `root` does the same job without `alias`'s
  trailing-slash and `try_files` pitfalls.
- Match the unlock page **extensionless** if the site rewrites `/foo.html` → `/foo`.
  Such a rewrite runs before location matching, so `location = /your-path/login.html`
  is never reached: the request falls into the gated location, gets redirected to
  `login.html`, is rewritten back, and loops until the browser gives up.
- Keep `try_files $uri $uri.html` for the same reason — without it, report links
  ending in `.html` are rewritten to extensionless URLs that match no file.

### HTTPS is not optional here

Whichever method you choose, the secret travels on every request. Over plain
HTTP a cookie value — like a Basic Auth header — is readable by anyone who can
see the traffic. Serve the path only over HTTPS and redirect HTTP to it.

The cookie is set with `Secure`, so over plain HTTP it is never sent at all and
the gate simply locks you out.

## Upload account

Give the upload its own SSH key and its own unprivileged user. The key sits on
whatever machine runs the scanner, so it should be able to do exactly one thing:
write into the publish directory.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/house_finder -C "house-finder upload"
```

Put the public half in the server user's `authorized_keys` and set
`VPS_SSH_KEY` to the private half. The uploader connects with
`BatchMode=yes`, so it fails fast rather than hanging on a prompt if the key is
wrong — which matters for an unattended 06:00 run.

Restrict the key in `authorized_keys`:

```
restrict ssh-ed25519 AAAA... house-finder upload
```

`restrict` disables port forwarding, agent forwarding, X11 and tty allocation.
The uploader only runs `scp` and non-interactive `ssh host 'command'`, neither of
which needs a tty, so no exception is required.

## Retention

`publish.keepDays` (default 60) and `publish.maxReports` (default 120) bound the
archive. Old reports are deleted locally, and the uploader mirrors that on the
server so it does not accumulate files forever. At three runs a day, 60 days is
roughly 180 reports of about 200 KB each — well under 40 MB.

## Checking it works

`$D` below is the 64-character digest from `printf %s 'your-password' | sha256sum`.

```bash
# 1. No cookie -> redirected to the unlock page, no content served
curl -sS -o /dev/null -w '%{http_code} -> %{redirect_url}\n' https://your-host/your-path/
# expect 302 -> .../login

# 2. Correct cookie -> content served
curl -sS -o /dev/null -w '%{http_code}\n' --cookie "hh=$D" https://your-host/your-path/
# expect 200

# 3. THE IMPORTANT ONE: reports must be gated too, not just the index.
#    Follow redirects and check where you land, rather than asserting one status
#    code - a site that rewrites /foo.html -> /foo answers 301 here first.
curl -sSL -o /dev/null -w '%{url_effective}\n' \
  https://your-host/your-path/reports/report-x.html
# expect the login page; anything still under /reports/ means the gate is bypassed

# 4. Wrong password is refused
curl -sS -o /dev/null -w '%{http_code}\n' --cookie 'hh=wrong' https://your-host/your-path/
# expect 302

# 5. The unlock page is reachable without a cookie, or there is no way in
curl -sS -o /dev/null -w '%{http_code}\n' https://your-host/your-path/login
# expect 200

# 6. A real report resolves for an authenticated visitor - catches both the
#    redirect loop and the missing try_files
curl -sSL -o /dev/null -w '%{num_redirects} hops, final %{http_code}\n' \
  --cookie "hh=$D" https://your-host/your-path/reports/report-x.html
# expect at most 1 hop and a final 200 - never a redirect loop
```

Check 3 is the one people forget. If you land anywhere under `/reports/`, the
gate is on the wrong location and every report is public.
